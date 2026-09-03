//! Length/format probes ported from `compile_resources.py`. These walk ROM
//! structures to discover how many bytes an object occupies so the extractor
//! can slice it out.

use crate::rom::{decomp, Result, Rom};

pub fn get_stripe_len(rom: &Rom, ea_org: u32) -> Result<u32> {
    let mut ea = ea_org;
    loop {
        let b = rom.get_byte(ea)?;
        if b & 0x80 != 0 {
            return Ok(ea + 1 - ea_org);
        }
        let p2 = rom.get_byte(ea + 2)? as u32;
        let p3 = rom.get_byte(ea + 3)? as u32;
        ea += 4;
        if p2 & 0x40 != 0 {
            ea += 2;
        } else {
            ea += ((p2 << 8 | p3) & 0x3fff) + 1;
        }
    }
}

/// RATS ("STAR") tags are how Lunar Magic marks its relocated data blocks.
pub fn get_rats_size(rom: &Rom, p: u32) -> Result<u32> {
    if p == 0 {
        return Ok(0);
    }
    let mut p = p - 8;
    if p & 0x8000 == 0 {
        p -= 0x8000;
    }
    if rom.get_bytes(p, 4)? != b"STAR" {
        return Err(format!("expected a RATS 'STAR' tag at {p:#x}"));
    }
    Ok(rom.get_word(p + 4)? + 1)
}

pub fn get_rats_bytes(rom: &Rom, p: u32) -> Result<Vec<u8>> {
    let n = get_rats_size(rom, p)?;
    rom.get_bytes(p, n as usize)
}

pub fn unpack_rle(rom: &Rom, ea_org: u32) -> Result<(Vec<u8>, u32)> {
    let mut ea = ea_org;
    let mut r = Vec::new();
    while rom.get_word(ea)? != 0xffff {
        let x = rom.get_byte(ea)?;
        ea += 1;
        if x & 0x80 != 0 {
            let y = rom.get_byte(ea)?;
            ea += 1;
            for _ in 0..((x & 0x7f) as u32 + 1) {
                r.push(y);
            }
        } else {
            for _ in 0..((x & 0x7f) as u32 + 1) {
                r.push(rom.get_byte(ea)?);
                ea += 1;
            }
        }
    }
    Ok((r, ea + 2 - ea_org))
}

pub fn unpack_rle_of_size(rom: &Rom, ea_org: u32, size: usize) -> Result<(Vec<u8>, u32)> {
    let mut ea = ea_org;
    let mut r = Vec::new();
    while r.len() < size {
        let x = rom.get_byte(ea)?;
        ea += 1;
        if x & 0x80 != 0 {
            let y = rom.get_byte(ea)?;
            ea += 1;
            for _ in 0..((x & 0x7f) as u32 + 1) {
                r.push(y);
            }
        } else {
            for _ in 0..((x & 0x7f) as u32 + 1) {
                r.push(rom.get_byte(ea)?);
                ea += 1;
            }
        }
    }
    Ok((r, ea - ea_org))
}

/// Walks a level's object list to find its end. Object ids 0x22..0x27 are the
/// Lunar Magic extensions with non-standard operand widths.
pub fn calc_level_len(rom: &Rom, ea_org: u32) -> Result<u32> {
    let mut ea = ea_org + 5;
    loop {
        let b0 = rom.get_byte(ea)? as u32;
        ea += 1;
        if b0 == 0xff {
            break;
        }
        let b1 = rom.get_byte(ea)? as u32;
        ea += 1;
        let b2 = rom.get_byte(ea)? as u32;
        ea += 1;

        let obj_id = (b1 >> 4) | ((b0 & 0x60) >> 1);
        let blocks_size_or_type = b2;

        if obj_id == 0 && blocks_size_or_type == 0 {
            ea += 1;
        } else if obj_id == 0x22 || obj_id == 0x23 {
            ea += 1;
        } else if obj_id == 0x24 || obj_id == 0x25 {
            // lunar deprecated: no operand
        } else if obj_id == 0x27 {
            ea += 2;
        }
    }
    Ok(ea - ea_org)
}

pub fn get_sprite_data_len(rom: &Rom, ea_org: u32) -> Result<u32> {
    let mut ea = ea_org + 1;
    while rom.get_byte(ea)? != 0xff {
        ea += 3;
    }
    Ok(ea + 1 - ea_org)
}

fn calc_one_exanim_end(rom: &Rom, p_org: u32) -> Result<u32> {
    let mut p = p_org;
    let tp = rom.get_byte(p)?;
    let trigger = rom.get_byte(p + 1)?;
    if (1..=0x13).contains(&tp) {
        let limit = rom.get_byte(p + 2)? as u32;
        p += 5; // type, trigger, limit, dest(w)
        p += (limit + 1) * 2 * (if trigger == 0 { 1 } else { 2 });
        return Ok(p);
    }
    Err(format!("exanim type {tp:x} not supported"))
}

pub fn calc_exanim_size(rom: &Rom, p_org: u32) -> Result<u32> {
    let mut p = p_org;
    let num = rom.get_word(p)?;
    let trig = rom.get_word(p + 6)?;
    p += 8;
    for i in 0..16 {
        if trig & (1 << i) != 0 {
            p += 2; // manual triggers
        }
    }
    let mut max_p = p;
    for i in 0..num {
        let pd = rom.get_word(p + i * 2)?;
        max_p = max_p.max(calc_one_exanim_end(rom, p + pd)?);
    }
    Ok(max_p - p_org)
}

/// The compressed bytes as they sit in ROM (not the decompressed payload) --
/// the firmware decompresses at runtime.
pub fn get_comp_data(rom: &Rom, ea: u32) -> Result<Vec<u8>> {
    let (_, comp_len) = decomp(ea, rom)?;
    rom.get_bytes(ea, comp_len as usize)
}
