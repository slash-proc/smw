//! Direct port of the ROM-access half of `assets/util.py`.
//!
//! Addressing is SNES LoROM: the Python asserts bit 15 of the effective address
//! and folds a 24-bit SNES address into a flat file offset. Every quirk below
//! (including the two *different* bank-wrap conditions in `get_bytes` vs
//! `Reader::next`) is reproduced literally, because the output must be
//! byte-identical to the Python.

pub type Result<T> = core::result::Result<T, String>;

pub const SMW_SHA1_US: &str = "6B47BB75D16514B6A476AA0C73A683A2A4C18765";

pub struct Rom {
    pub data: Vec<u8>,
}

impl Rom {
    /// Mirrors `LoadedRom.__init__`: strip a 512-byte SMC copier header if
    /// present, then gate on the US SHA-1 unless the caller bypasses it.
    pub fn new(mut data: Vec<u8>, disable_hash_check: bool) -> Result<Rom> {
        if (data.len() & 0xfffff) == 0x200 {
            data.drain(..0x200);
        }
        let hash = crate::hash::hex_upper(&crate::hash::sha1(&data));
        let is_us = hash == SMW_SHA1_US;
        if !disable_hash_check && !is_us {
            return Err(format!(
                "ROM with hash {hash} not supported.\n\nExpected {SMW_SHA1_US}.\nPlease verify your ROM is \"Super Mario World\"."
            ));
        }
        Ok(Rom { data })
    }

    #[inline]
    pub fn get_byte(&self, ea: u32) -> Result<u8> {
        if ea & 0x8000 == 0 {
            return Err(format!("bad effective address {ea:#x} (bit 15 clear)"));
        }
        let off = (((ea >> 16) & 0x7f) * 0x8000 + (ea & 0x7fff)) as usize;
        self.data
            .get(off)
            .copied()
            .ok_or_else(|| format!("read past end of ROM at {ea:#x} (offset {off:#x})"))
    }

    #[inline]
    pub fn get_word(&self, ea: u32) -> Result<u32> {
        Ok(self.get_byte(ea)? as u32 + self.get_byte(ea + 1)? as u32 * 256)
    }

    #[inline]
    pub fn get_24(&self, ea: u32) -> Result<u32> {
        Ok(self.get_byte(ea)? as u32
            + self.get_byte(ea + 1)? as u32 * 256
            + self.get_byte(ea + 2)? as u32 * 65536)
    }

    pub fn get_bytes(&self, mut addr: u32, n: usize) -> Result<Vec<u8>> {
        let mut r = Vec::with_capacity(n);
        for _ in 0..n {
            r.push(self.get_byte(addr)?);
            addr += 1;
            if addr & 0x8000 == 0 {
                addr += 0x8000;
            }
        }
        Ok(r)
    }

    pub fn get_words(&self, mut addr: u32, n: usize) -> Result<Vec<u16>> {
        let mut r = Vec::with_capacity(n);
        for _ in 0..n {
            r.push(self.get_word(addr)? as u16);
            addr += 2;
            if addr & 0x8000 == 0 {
                addr += 0x8000;
            }
        }
        Ok(r)
    }
}

/// `util.Reader` — note the wrap test is `(ea & 0xffff) == 0`, which differs
/// from `get_bytes`' `(addr & 0x8000) == 0`. Not a typo on our part.
pub struct Reader<'a> {
    pub ea: u32,
    rom: &'a Rom,
}

impl<'a> Reader<'a> {
    pub fn new(ea: u32, rom: &'a Rom) -> Self {
        Reader { ea, rom }
    }
    pub fn next(&mut self) -> Result<u8> {
        let r = self.rom.get_byte(self.ea)?;
        self.ea += 1;
        if self.ea & 0xffff == 0 {
            self.ea += 0x8000;
        }
        Ok(r)
    }
}

/// `util.decomp` — the SMW LZ variant. Returns (data, compressed_length).
pub fn decomp(ea: u32, rom: &Rom) -> Result<(Vec<u8>, u32)> {
    let mut result: Vec<u8> = Vec::new();
    let mut reader = Reader::new(ea, rom);
    loop {
        let b = reader.next()? as u32;
        if b == 0xff {
            return Ok((result, (reader.ea - ea) & 0x7fff));
        }
        let (cmd, mut lx) = if (b & 0xe0) != 0xe0 {
            (b & 0xe0, b & 0x1f)
        } else {
            let lo = reader.next()? as u32;
            ((b << 3) & 0xe0, ((b & 3) << 8) | lo)
        };
        lx += 1;

        if cmd == 0x00 {
            // 000 - literal
            for _ in 0..lx {
                let v = reader.next()?;
                result.push(v);
            }
        } else if cmd & 0x80 != 0 {
            // 1xx - copy from already-emitted output
            let mut offs = (reader.next()? as usize) << 8;
            offs |= reader.next()? as usize;
            for _ in 0..lx {
                let v = *result
                    .get(offs)
                    .ok_or_else(|| format!("decomp copy out of range at {offs:#x}"))?;
                result.push(v);
                offs += 1;
            }
        } else if cmd & 0x40 == 0 {
            // 00x - memset
            let v = reader.next()?;
            for _ in 0..lx {
                result.push(v);
            }
        } else if cmd & 0x20 == 0 {
            // 010 - memset16
            let (b1, b2) = (reader.next()?, reader.next()?);
            let mut n = lx;
            while n > 0 {
                result.push(b1);
                if n == 1 {
                    break;
                }
                result.push(b2);
                n -= 2;
            }
        } else {
            // 011 - incrementing run
            let mut v = reader.next()?;
            for _ in 0..lx {
                result.push(v);
                v = v.wrapping_add(1);
            }
        }
    }
}
