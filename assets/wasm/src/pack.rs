//! Port of the asset-container half of `compile_resources.py`:
//! `pack_arrays`, `pack_blob`, and `write_assets_to_file`.

use crate::hash::sha256;
use crate::rom::{Result, Rom};

/// Asset element type. Only used to interpret the caller's data on the way in;
/// the container format itself stores raw bytes plus a name.
pub struct Assets {
    pub items: Vec<(String, Vec<u8>)>,
}

impl Assets {
    pub fn new() -> Assets {
        Assets { items: Vec::new() }
    }

    fn add(&mut self, name: &str, data: Vec<u8>) {
        debug_assert!(
            !self.items.iter().any(|(n, _)| n == name),
            "duplicate asset {name}"
        );
        self.items.push((name.to_string(), data));
    }

    pub fn u8(&mut self, name: &str, data: Vec<u8>) {
        self.add(name, data);
    }

    pub fn u16(&mut self, name: &str, data: Vec<u16>) {
        let mut out = Vec::with_capacity(data.len() * 2);
        for v in data {
            out.extend_from_slice(&v.to_le_bytes());
        }
        self.add(name, out);
    }

    pub fn packed(&mut self, name: &str, data: Vec<Vec<u8>>) {
        let v = pack_arrays(&data);
        self.add(name, v);
    }

    pub fn blob(&mut self, name: &str, ranges: Vec<(u32, u32)>, rom: &Rom) -> Result<()> {
        let v = pack_blob(ranges, rom)?;
        self.add(name, v);
        Ok(())
    }
}

pub fn pack_24(v: u32) -> [u8; 3] {
    debug_assert!(v < (1 << 24));
    [v as u8, (v >> 8) as u8, (v >> 16) as u8]
}

/// Deduplicates the sub-arrays, then emits an offset table whose element width
/// (u16/u32) and optional indirection table are chosen automatically. The
/// `flags` word in the tail records which layout was picked.
pub fn pack_arrays(arr: &[Vec<u8>]) -> Vec<u8> {
    if arr.is_empty() {
        return Vec::new();
    }
    // Insertion-ordered dedup map, matching CPython dict iteration order.
    let mut backmap: Vec<Vec<u8>> = Vec::new();
    let mut index: std::collections::HashMap<Vec<u8>, usize> = std::collections::HashMap::new();
    let mut fstmap: Vec<usize> = Vec::with_capacity(arr.len());
    let mut all_offs: Vec<usize> = Vec::new();
    let mut offs = 0usize;

    for v in arr {
        let k = match index.get(v) {
            Some(&k) => k,
            None => {
                let k = all_offs.len();
                index.insert(v.clone(), k);
                backmap.push(v.clone());
                offs += v.len();
                all_offs.push(offs);
                k
            }
        };
        fstmap.push(k);
    }
    debug_assert!(arr.len() <= 4096);
    all_offs.pop();

    let mut flags = (arr.len() - 1) as u32;
    let mut r: Vec<u8> = Vec::new();

    if all_offs.is_empty() || *all_offs.last().unwrap() < 65536 {
        for &i in &all_offs {
            r.extend_from_slice(&(i as u16).to_le_bytes());
        }
        flags |= 0x8000;
    } else {
        for &i in &all_offs {
            r.extend_from_slice(&(i as u32).to_le_bytes());
        }
    }
    for v in &backmap {
        r.extend_from_slice(v);
    }

    if backmap.len() != arr.len() {
        if all_offs.len() <= 255 {
            for &k in &fstmap {
                r.push(k as u8);
            }
        } else {
            for &k in &fstmap {
                r.extend_from_slice(&(k as u16).to_le_bytes());
            }
        }
        r.extend_from_slice(&(all_offs.len() as u16).to_le_bytes());
        flags |= 0x4000;
    }
    r.extend_from_slice(&(flags as u16).to_le_bytes());
    r
}

/// Merges overlapping ROM ranges and emits them as a lookup table plus the
/// concatenated bytes, so the runtime can map a SNES address into the blob.
pub fn pack_blob(ranges: Vec<(u32, u32)>, rom: &Rom) -> Result<Vec<u8>> {
    let mut sorted = ranges;
    sorted.sort();
    let mut out: Vec<(u32, u32)> = Vec::new();
    for (a, b) in sorted {
        if let Some(last) = out.last_mut() {
            if a <= last.1 {
                if b > last.1 {
                    last.1 = b;
                }
                continue;
            }
        }
        out.push((a, b));
    }

    let mut off = 2 + out.len() as u32 * 6;
    let (mut a_arr, mut b_arr, mut r_arr) = (Vec::new(), Vec::new(), Vec::new());
    for &(a, b) in &out {
        a_arr.extend_from_slice(&pack_24(a));
        b_arr.extend_from_slice(&pack_24(off));
        r_arr.extend_from_slice(&rom.get_bytes(a, (b - a) as usize)?);
        off += b - a;
    }

    let mut r = Vec::new();
    r.extend_from_slice(&(out.len() as u16).to_le_bytes());
    r.extend_from_slice(&a_arr);
    r.extend_from_slice(&b_arr);
    r.extend_from_slice(&r_arr);
    Ok(r)
}

/// `write_assets_to_file` — the on-disk `smw_assets.dat` layout.
pub fn serialize(assets: &Assets) -> Vec<u8> {
    let mut key_sig: Vec<u8> = Vec::new();
    for (k, _) in &assets.items {
        key_sig.extend_from_slice(k.as_bytes());
        key_sig.push(0);
    }

    let mut file_data: Vec<u8> = Vec::new();
    file_data.extend_from_slice(b"Smw_v0        \n\0");
    file_data.extend_from_slice(&sha256(&key_sig));
    file_data.extend_from_slice(&[0u8; 32]);
    file_data.extend_from_slice(&(assets.items.len() as u32).to_le_bytes());
    file_data.extend_from_slice(&(key_sig.len() as u32).to_le_bytes());

    for (_, data) in &assets.items {
        file_data.extend_from_slice(&(data.len() as u32).to_le_bytes());
    }
    file_data.extend_from_slice(&key_sig);

    for (_, v) in &assets.items {
        while file_data.len() & 3 != 0 {
            file_data.push(0);
        }
        file_data.extend_from_slice(v);
    }
    file_data
}
