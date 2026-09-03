//! Port of `compile_resources.print_all`. The order of `add_*` calls defines
//! the asset table layout and feeds the name hash in the container header, so
//! it must match the Python exactly -- do not reorder.

use crate::codec::*;
use crate::pack::{pack_24, Assets};
use crate::rom::{decomp, Result, Rom};

// Lunar Magic feature bits, mirrored from the Python constants.
const LM_ENABLED: u32 = 1 << 0;
const LM_EXANIM: u32 = 1 << 1;
const LM_SKIP_OVERWORLD_DECOMPRESS: u32 = 1 << 2;
const LM_OVERWORLD_TILES_4BPP: u32 = 1 << 3;
const LM_COPY_512_COLORS: u32 = 1 << 4;
const LM_WEIRD_PALETTE: u32 = 1 << 5;
const LM_SKIP_LOAD_PALETTE_HOOK: u32 = 1 << 6;
const LM_GFX_UPLOAD: u32 = 1 << 7;
const LM_LOAD_LEVEL: u32 = 1 << 8;
const LM_4BPP_GFX: u32 = 1 << 9;
const LM_CUSTOM_TITLE_SCREEN_DEMO: u32 = 1 << 10;
const LM_CUSTOM_DISPLAY_MESSAGE: u32 = 1 << 11;
const LM_DONT_SET_YPOS_FOR_INTRO_MARCH: u32 = 1 << 12;
const LM_OW_PALETTE: u32 = 1 << 13;
const LM_LEVEL_NAMES_PATCH: u32 = 1 << 14;
const LM_DESTROY_TILE_ANIMS: u32 = 1 << 15;
const LM_EVENT_STUFF: u32 = 1 << 16;
const LM_MUSIC_REG_TWEAK: u32 = 1 << 17;
const LM_TIDE_WATER_TWEAK: u32 = 1 << 18;
const LM_ENEMY_COLL_TWEAK: u32 = 1 << 19;
const LM_OW_4BPP_GFX: u32 = 1 << 20;
const LM_DONT_RESET_OW_PLAYERS_MAP: u32 = 1 << 21;
const LM_NON_STD_GFX_AA8D: u32 = 1 << 22;
const LM_TIMER_TWEAKS: u32 = 1 << 23;
const LM_NO_DEFAULT_SAVE_PROMPTS: u32 = 1 << 24;

const HACK_WALLJUMP: u32 = 1 << 0;

const LM_HELP: &str = "\n\nDo the following steps:\n1) Use Lunar Magic 3.33.\n\
2) Open up a level, modify something, save it.\n\
3) Open up the 16x16 tile map editor, edit something, save it.\n\
4) Open up the Exanim editor for some level. Edit something, save.\n";

#[derive(Default)]
struct LmFeatures {
    flags: u32,
    lvl_info_addr: u32,
    lvl_info_addr_other: u32,
    hacks: u32,
}

impl LmFeatures {
    fn serialize(&self) -> Vec<u8> {
        let mut v = Vec::with_capacity(16);
        for x in [self.flags, self.lvl_info_addr, self.lvl_info_addr_other, self.hacks] {
            v.extend_from_slice(&x.to_le_bytes());
        }
        v
    }
}

pub struct Ctx {
    rom: Rom,
    a: Assets,
    lm: LmFeatures,
    lunar_magic: bool,
    include_rom: bool,
    /// Diagnostics that the Python writes to stderr; surfaced to the caller
    /// instead, since a wasm module has nowhere to print.
    pub warnings: Vec<String>,
}

fn remove_trail_zero(mut s: Vec<u8>) -> Vec<u8> {
    while s.last() == Some(&0) {
        s.pop();
    }
    s
}

fn remove_trail_zero_u32(mut s: Vec<u32>) -> Vec<u32> {
    while s.last() == Some(&0) {
        s.pop();
    }
    s
}

fn remove_trail_empty(mut s: Vec<Vec<u8>>) -> Vec<Vec<u8>> {
    while s.last().map(|v| v.is_empty()) == Some(true) {
        s.pop();
    }
    s
}

impl Ctx {
    fn b(&self, ea: u32) -> Result<u8> {
        self.rom.get_byte(ea)
    }
    fn w(&self, ea: u32) -> Result<u32> {
        self.rom.get_word(ea)
    }
    fn l(&self, ea: u32) -> Result<u32> {
        self.rom.get_24(ea)
    }
    fn bs(&self, ea: u32, n: usize) -> Result<Vec<u8>> {
        self.rom.get_bytes(ea, n)
    }
    fn ws(&self, ea: u32, n: usize) -> Result<Vec<u16>> {
        self.rom.get_words(ea, n)
    }

    /// `do_u16`/`do_u8`: read a pointer that Lunar Magic may have relocated. If
    /// it still points at the vanilla address, use the known vanilla size;
    /// otherwise trust the RATS tag at the new location.
    fn do_sized(
        &mut self,
        name: &str,
        addr: u32,
        org_addr: u32,
        org_size: usize,
        bank_addr: Option<u32>,
        words: bool,
    ) -> Result<bool> {
        let p = match bank_addr {
            None => self.l(addr)?,
            Some(ba) => self.w(addr)? | (self.b(ba)? as u32) << 16,
        };
        let moved = p != org_addr;
        if moved && !self.lunar_magic {
            return Err(format!(
                "{name}: pointer at {addr:#x} moved to {p:#x} but this is not a Lunar Magic ROM"
            ));
        }
        if words {
            let sz = if moved {
                (get_rats_size(&self.rom, p)? / 2) as usize
            } else {
                org_size
            };
            let v = self.ws(p, sz)?;
            self.a.u16(name, v);
        } else {
            let sz = if moved {
                get_rats_size(&self.rom, p)? as usize
            } else {
                org_size
            };
            let v = self.bs(p, sz)?;
            self.a.u8(name, v);
        }
        Ok(moved)
    }

    fn add_packed_levels(&mut self, name: &str, addr: u32, num: u32, bank: Option<u32>) -> Result<()> {
        let mut r = Vec::new();
        for i in 0..num {
            // The Python wraps this in try/except and drops levels it cannot
            // decode, warning the user to re-save them in Lunar Magic.
            let attempt = (|| -> Result<Vec<u8>> {
                let ea = match bank {
                    None => self.l(addr + i * 3)?,
                    Some(bk) => self.w(addr + i * 2)? | bk << 16,
                };
                let ln = calc_level_len(&self.rom, ea)?;
                self.bs(ea, ln as usize)
            })();
            match attempt {
                Ok(v) => r.push(v),
                Err(e) => self.warnings.push(format!(
                    "Crashed while decoding level {i:#x} ({name}): {e}. Try opening it in LM and then saving it."
                )),
            }
        }
        self.a.packed(name, r);
        Ok(())
    }

    fn add_packed_level_bg(&mut self, name: &str, addr: u32, num: u32, mode: Option<&str>) -> Result<()> {
        let mut r = Vec::new();
        let mut fls: Vec<u8> = Vec::new();
        for i in 0..num {
            let mut ea = match mode {
                None => self.l(addr + i * 3)?,
                Some("choc") => self.w(addr + i * 2)? | 0xff0000,
                Some("end") => self.w(addr + i * 2)? | if i != 12 { 0xff0000 } else { 0xc0000 },
                _ => return Err("bad mode".into()),
            };

            let mut fl = if num == 0x200 && self.lunar_magic {
                self.b(0xEF310 + i)?
            } else {
                0
            };
            if ea & 0xff0000 == 0xff0000 {
                ea = (ea & 0xffff) | 0xc0000;
                fl = (((ea & 0xffff) >= 0xE8FE) as u8) << 4 | 2;
            }
            fls.push(fl);

            let ln = if fl & 2 != 0 {
                unpack_rle(&self.rom, ea)?.1
            } else {
                calc_level_len(&self.rom, ea)?
            };
            r.push(self.bs(ea, ln as usize)?);
        }
        self.a.packed(name, r);
        self.a.u8(&format!("{name}_IsBg"), fls);
        Ok(())
    }
}

pub struct Extraction {
    pub data: Vec<u8>,
    pub warnings: Vec<String>,
}

impl Ctx {
    /// Reads the ROM header and validates it. Everything after this is a
    /// phase; this is the part that must succeed before any phase can run.
    pub fn new(rom: Rom, include_rom: bool) -> Result<Ctx> {
        let lunar_magic = rom.get_bytes(0xFF0A0, 5)? == b"Lunar";

        let mut c = Ctx {
            rom,
            a: Assets::new(),
            lm: LmFeatures::default(),
            lunar_magic,
            include_rom,
            warnings: Vec::new(),
        };

        if lunar_magic {
            let s = String::from_utf8_lossy(&c.bs(0xFF0A0, 24)?).to_string();
            c.warnings.push(format!("Detected {s}"));
            if s != "Lunar Magic Version 3.33" {
                return Err(format!(
                    "Invalid Lunar Magic version. Expected 3.33, found \"{s}\"\n{LM_HELP}"
                ));
            }
            if c.b(0x6F540)? != 0xc9 {
                return Err(format!("The map16 file format is incorrect. {LM_HELP}"));
            }
        }

        Ok(c)
    }

    /// Serialises everything the phases accumulated. Runs once, after the last
    /// phase.
    pub fn finish(mut self) -> Extraction {
        let feat = self.lm.serialize();
        self.a.u8("kLmFeatures", feat);
        Extraction {
            data: crate::pack::serialize(&self.a),
            warnings: self.warnings,
        }
    }
}

// ---------------------------------------------------------------------------
// Phases
//
// The extraction is split into named, independently runnable steps so a host
// can drive it incrementally: see `Session` in lib.rs. Each phase reads from
// the ROM and appends to the accumulator in `Ctx`; nothing else crosses a
// phase boundary, which is what makes stopping between them safe.
// ---------------------------------------------------------------------------

/// graphics
fn phase_graphics(c: &mut Ctx) -> Result<()> {
    let (lo, hi, bank) = (c.bs(0xB992, 50)?, c.bs(0xB9c4, 50)?, c.bs(0xB9f6, 50)?);
    let mut r = Vec::new();
    for i in 0..50 {
        let p = (bank[i] as u32) << 16 | (hi[i] as u32) << 8 | lo[i] as u32;
        r.push(get_comp_data(&c.rom, p)?);
    }
    c.a.packed("kGraphicsPtrs", r);

    let (data, _) = decomp(0x80000 | c.w(0xB8D8)?, &c.rom)?;
    c.a.u8("kGfx32", data);
    let (data, _) = decomp(0x80000 | c.w(0xB88B)?, &c.rom)?;
    c.a.u8("kGfx33", data);

    let mut r = vec![Vec::new()];
    for i in 1..86 {
        let p = c.l(0x84D0 + i * 3)?;
        let pl = get_stripe_len(&c.rom, p)?;
        r.push(c.bs(p, pl as usize)?);
    }
    c.a.packed("kLoadStripeImagePtrs", r);

    let mut r = Vec::new();
    for i in 0..45 {
        let p = c.l(0x59000 + i * 3)?;
        let pl = get_stripe_len(&c.rom, p)?;
        r.push(c.bs(p, pl as usize)?);
    }
    c.a.packed("kLayer3ImagePtrs", r);
    Ok(())
}

/// audio
fn phase_audio(c: &mut Ctx) -> Result<()> {
    let v = c.bs(0x3e400, 6624)?;
    c.a.u8("kSpcCreditsMusicBank", v);
    let v = c.bs(0xEAED6, 16899)?;
    c.a.u8("kSpcLevelMusicBank", v);
    let mut v = c.bs(0xe8000, 6321)?;
    v.extend_from_slice(&[0, 0]);
    c.a.u8("kSpcEngine", v);
    let v = c.bs(0xf8000, 28538)?;
    c.a.u8("kSpcSamples", v);
    let v = c.bs(0xe98b1, 5667)?;
    c.a.u8("kSpcOverworldMusicBank", v);
    Ok(())
}

/// map16 / palettes
fn phase_map16_palettes(c: &mut Ctx) -> Result<()> {
    let v = c.ws(0x05d000, 772)?;
    c.a.u16("kMap16Data_OverworldLayer1", v);
    let v = c.ws(0xd8000, (0xA100 - 0x8000) / 2)?;
    c.a.u16("kMap16Data", v);
    for (name, addr) in [
        ("kMap16Data_Castle", 0xdbc00u32),
        ("kMap16Data_Rope", 0xdc800),
        ("kMap16Data_Underground", 0xdd400),
        ("kMap16Data_GhostHouse", 0xde300),
    ] {
        let v = c.ws(addr, 712)?;
        c.a.u16(name, v);
    }

    for (name, addr, n) in [
        ("kGlobalPalettes_Sky", 0x00B0A0u32, 16usize),
        ("kGlobalPalettes_Background", 0x00B0B0, 96),
        ("kGlobalPalettes_Layer3", 0xB170, 16),
        ("kGlobalPalettes_Foreground", 0x00B190, 96),
        ("kGlobalPalettes_Objects", 0x00B250, 60),
        ("kPlayerPalettes", 0x00B2C8, 40),
        ("kGlobalPalettes_Sprites", 0x00B318, 84),
        ("kGlobalPalettes_YoshiBerry", 0x00B674, 21),
        ("kGlobalPalettes_Flashing", 0x00B60C, 16),
        ("kGlobalPalettes_OW_Objects", 0xB528, 42),
        ("kGlobalPalettes_OW_Sprites", 0xB57C, 56),
        ("kGlobalPalettes_B5EC", 0xB5EC, 16),
        ("kGlobalPalettes_OW_Areas", 0xB3D8, 168),
        ("kGlobalPalettes_OW_AreasPassed", 0xB732, 168),
        ("kGlobalPalettes_Bowser", 0xB69E, 56),
        ("kGlobalPalettes_Layer3Smasher", 0xB66C, 4),
    ] {
        let v = c.ws(addr, n)?;
        c.a.u16(name, v);
    }

    let v = c.bs(0xC95C7, 1873)?;
    c.a.u8("kGameMode1B_EndingCinema_Tilemaps", v);
    let v = c.ws(0xC9D18, 202)?;
    c.a.u16("kGameMode1B_EndingCinema_RowPointers", v);

    for (name, addr) in [
        ("kLevelInfo_05F000", 0x5f000u32),
        ("kLevelInfo_05F200", 0x5f200),
        ("kLevelInfo_05F400", 0x5f400),
        ("kLevelInfo_05F600", 0x5f600),
    ] {
        let v = c.bs(addr, 0x200)?;
        c.a.u8(name, v);
    }

    let v = c.bs(0x5D608, 0x100)?;
    c.a.u8("kLoadLevel_DATA_05D608", v);
    let v = c.bs(0x5A5D9, 2854)?;
    c.a.u8("kDisplayMessage_DATA_05A5D9", v);
    let v = c.bs(0x4F708, 128)?;
    c.a.u8("kOverworldLightningAndRandomCloudSpawning", v);
    let v = c.ws(0x4A0FC, 256)?;
    c.a.u16("kLevelNames", v);
    let v = c.bs(0x7F9DB, 536)?;
    c.a.u8("kLineGuideSpeedTableData", v);
    Ok(())
}

/// levels
fn phase_levels(c: &mut Ctx) -> Result<()> {
    c.add_packed_levels("kLevelData_Layer1", 0x5E000, 0x200, None)?;
    c.add_packed_levels("kEntranceData_Layer1", 0x5d766, 6, None)?;
    c.add_packed_levels("kChoclateIsland2_Layer1", 0x5DB08, 9, Some(6))?;
    c.add_packed_levels("kRollCallData_Layer1", 0xCAD58, 13, Some(0xc))?;

    c.add_packed_level_bg("kLevelData_Layer2", 0x5E600, 0x200, None)?;
    c.add_packed_level_bg("kEntranceData_Layer2", 0x5d778, 6, None)?;
    c.add_packed_level_bg("kChoclateIsland2_Layer2", 0x5DB2C, 9, Some("choc"))?;
    c.add_packed_level_bg("kRollCallData_Layer2", 0xCAD72, 13, Some("end"))?;
    c.add_packed_level_bg("kBufferCreditsBackgrounds_Layer2", 0xc93c1, 7, Some("choc"))?;
    Ok(())
}

/// sprites
fn phase_sprites(c: &mut Ctx) -> Result<()> {
    {
        let mut spr_ranges: Vec<(u32, u32)> = Vec::new();
        let banks = if c.b(0x05D8F5)? == 0x22 {
            c.bs(0xef100, 512)?
        } else {
            vec![7u8; 512]
        };
        for i in 0..0x200u32 {
            let ea = c.w(0x5ec00 + i * 2)? | (banks[i as usize] as u32) << 16;
            let lx = get_sprite_data_len(&c.rom, ea)?;
            spr_ranges.push((ea, ea + lx));
        }
        let lx = get_sprite_data_len(&c.rom, 0x7c3ee)?;
        spr_ranges.push((0x7c3ee, 0x7c3ee + lx));
        for i in 0..9u32 {
            let ea = c.w(0x5DB1A + i * 2)? | 0x70000;
            let lx = get_sprite_data_len(&c.rom, ea)?;
            spr_ranges.push((ea, ea + lx));
        }
        c.a.blob("kLvlSprBlob", spr_ranges, &c.rom)?;
        c.a.u8("kLmSpritePtrBankByte", banks);
    }

    let v = c.ws(0x5EC00, 0x200)?;
    c.a.u16("kLoadLevel_SpriteDataPtrs", v);
    let v = c.bs(0x5B6FE, 203 + 204)?;
    c.a.u8("kFileSelectText_EraseFile", v);
    let v = c.bs(0x3D9DE, 912)?;
    c.a.u8("kInitializeMode7TilemapsAndPalettes_TilemapData", v);
    Ok(())
}

/// overworld events
fn phase_overworld_events(c: &mut Ctx) -> Result<()> {
    c.do_sized("kLayer2EventData_TileEntries", 0x4E49F, 0x4DD8D, 742, None, true)?;
    c.do_sized("kChangingLayer1OverworldTiles_Layer1TileLocation", 0x4EC8C, 0x4D85D, 112, None, true)?;
    c.do_sized("kOwEventProcess01_DestroyTileAnimation_DATA_04E587", 0x4EEC9, 0x4E587, 16, None, true)?;
    if c.do_sized("kCheckIfDestroyTileEventIsActive_DATA_04E5B6", 0x4E69C, 0x4E5B6, 16, None, true)? {
        c.lm.flags |= LM_DESTROY_TILE_ANIMS;
    }
    c.do_sized("kOwEventProcess01_DestroyTileAnimation_DATA_04D93D", 0x4EDB8, 0x4D93D, 112, None, true)?;
    c.do_sized("kOwEventProcess07_SilentEventsAndEndOfEvent_SilentEventTiles", 0x4E9F4, 0x4E8E4, 44, None, false)?;
    c.do_sized("kOwEventProcess07_SilentEventsAndEndOfEvent_SilentEventTiles_TileLayer", 0x4EA27, 0x4E910, 44, None, false)?;
    c.do_sized("kOwEventProcess07_SilentEventsAndEndOfEvent_SilentEventTiles_TileNum", 0x4EA31 + 1, 0x4E994, 44, None, true)?;
    c.do_sized("kOwEventProcess07_SilentEventsAndEndOfEvent_SilentEventTiles_TilemapLocation", 0x4EA37 + 1, 0x4E93C, 44, None, true)?;

    let v = c.bs(0x4e5a7, 5)?;
    c.a.u8("kOwDestruction_TileToIdx_04E5A7", v);
    let v = c.bs(0x4e5ac, 5)?;
    c.a.u8("kOwDestruction_TopTile_04E5AC", v);
    let v = c.bs(0x4e5b1, 5)?;
    c.a.u8("kOwDestruction_BottomTile_04E5B1", v);
    c.do_sized("kOwDestruction_TriggerEvent_04E5D6", 0x4E67C, 0x4e5d6, 16, None, false)?;
    Ok(())
}

/// Lunar Magic event tables
fn phase_lunar_magic_event_tables(c: &mut Ctx) -> Result<()> {
    {
        let (mut r1, mut r2, mut r3) = (Vec::new(), Vec::new(), Vec::new());
        let mut r4 = Vec::new();
        if c.b(0x4E9F7)? == 0x22 {
            c.lm.flags |= LM_EVENT_STUFF;
            let p = c.l(0x4E9F8)?;
            let base = p - 0x8008;
            for (dst_words, off) in [(1u8, 0x8014u32), (2, 0x8029), (3, 0x802F)] {
                let pp = c.l(base + off + 1)?;
                let n = (get_rats_size(&c.rom, pp)? / 2) as usize;
                let v = c.ws(pp, n)?;
                match dst_words {
                    1 => r1 = v,
                    2 => r2 = v,
                    _ => r3 = v,
                }
            }
            let pp = c.l(base + 0x803B + 1)?;
            let n = get_rats_size(&c.rom, pp)? as usize;
            r4 = c.bs(pp, n)?;
        }
        c.a.u16("kLmEventStuff1", r1);
        c.a.u16("kLmEventStuff2", r2);
        c.a.u16("kLmEventStuff3", r3);
        c.a.u8("kLmEventStuff4", r4);
    }

    c.do_sized("kOverworldLayer2EventTilemap_Tiles", 0x4EAF5, 0xc8000, 3328, None, false)?;

    let p = c.w(0x4DC72)? | (c.b(0x4DC79)? as u32) << 16;
    let (_, sz) = unpack_rle_of_size(&c.rom, p, 0x2000)?;
    let v = c.bs(p, sz as usize)?;
    c.a.u8("kLoadOverworldLayer2AndEventsTilemaps_OverworldLayer2Tilemap", v);

    let p = c.w(0x4DC8d)? | (c.b(0x4DC79)? as u32) << 16;
    let (_, sz) = unpack_rle_of_size(&c.rom, p, 0x2000)?;
    let v = c.bs(p, sz as usize)?;
    c.a.u8("kLoadOverworldLayer2AndEventsTilemaps_OverworldLayer2Tilemap_Prop", v);

    c.do_sized("kOverworldLayer2EventTilemap_Prop", 0x4DD45, 0xC8D00, 1642, Some(0x4DD4a), false)?;

    let v = c.bs(0xCF7DF, 0x800)?;
    c.a.u8("kLoadOverworldLayer1AndEvents_DATA_0CF7DF", v);

    c.a.u8("kRom", if c.include_rom { c.rom.data.clone() } else { Vec::new() });

    let v = c.bs(0x49ac5, 460)?;
    c.a.u8("kUpdateLevelName_LevelNameStrings", v);
    let v = c.bs(0xCAF11, 1681)?;
    c.a.u8("kGameMode25_ShowEnemyRollcallScreen_TileData", v);
    Ok(())
}

/// Lunar Magic palettes
fn phase_lunar_magic_palettes(c: &mut Ctx) -> Result<()> {
    {
        let mut lm_pals = Vec::new();
        if c.lunar_magic && c.l(0xef577)? == 0xf58320 {
            for i in 0..0x200u32 {
                let pp = c.l(0xEF600 + i * 3)?;
                lm_pals.push(if pp != 0 { c.bs(pp, 0x202)? } else { Vec::new() });
            }
        }
        c.a.packed("kLmPalettes", lm_pals);
    }

    for (name, addr, n) in [
        ("kPlayerGFXRt_HeadTilePointerIndex", 0xE00Cu32, 192usize),
        ("kPlayerGFXRt_BodyTilePointerIndex", 0xE0CC, 192),
        ("kLvlInitialFlags", 0x5DDA0, 96),
        ("kLoadOverworldSprites_SpriteSlotData", 0x4F625, 65),
        ("kChangingLayer1OverworldTiles_TilesThatChange", 0x4DA1D, 22),
        ("kChangingLayer1OverworldTiles_TilesToBecome", 0x4DA33, 22),
        ("kOverworldEventProcess01_DestroyTileAnimation_DATA_04EE7A", 0x4EE7A, 48),
    ] {
        let v = c.bs(addr, n)?;
        c.a.u8(name, v);
    }

    let v = c.ws(0x5B999, 208)?;
    c.a.u16("kLevelTileAnimations_FrameData", v);
    let v = c.bs(0xDC78, 4)?;
    c.a.u8("kSetPlayerPose_WalkingPoseCount", v);

    for (name, addr) in [
        ("kDrawLoadingLetters_TileData", 0x90d1u32),
        ("kDrawLoadingLetters_TileData_BottomTiles", 0x9105),
        ("kDrawLoadingLetters_TileData_TopProp", 0x9139),
        ("kDrawLoadingLetters_TileData_BottomProp", 0x916A),
    ] {
        let v = c.bs(addr, 52)?;
        c.a.u8(name, v);
    }

    let v = c.ws(0x48000, 3)?;
    c.a.u16("kOwTileAnimations_WaterTileNumbers", v);
    let v = c.ws(0x48006, 64)?;
    c.a.u16("kOwTileAnimations_TileNumbers", v);
    Ok(())
}

/// star pipe warps
fn phase_star_pipe_warps(c: &mut Ctx) -> Result<()> {
    if c.b(0x48509)? == 0x22 {
        let p = c.l(0x4850a)?;
        let n = (c.w(p + 0xe00f - 0xdfff)? / 2) as usize;
        let pp = c.l(p + 0xe016 - 0xdfff)?;
        let v = c.ws(pp, n)?;
        c.a.u16("kOwStarPipeWarp_SrcX_048431", v);
        let pp = c.l(p + 0xe026 - 0xdfff)?;
        let v = c.ws(pp, n)?;
        c.a.u16("kOwStarPipeWarp_SrcY_048467", v);
        if c.b(0x48566)? != 0x22 {
            return Err("expected a JSL at 0x48566 for the star pipe warp patch".into());
        }
        let p = c.l(0x48567)?;
        let pp = c.l(p + 0xe04b - 0xe03f)?;
        let v = c.ws(pp, n)?;
        c.a.u16("kOwStarPipeWarp_DstX_04849D", v);
        let pp = c.l(p + 0xe05d - 0xe03f)?;
        let v = c.ws(pp, n)?;
        c.a.u16("kOwStarPipeWarp_DstY_0484D3", v);
    } else {
        for (name, addr) in [
            ("kOwStarPipeWarp_SrcX_048431", 0x48431u32),
            ("kOwStarPipeWarp_SrcY_048467", 0x48467),
            ("kOwStarPipeWarp_DstX_04849D", 0x4849d),
            ("kOwStarPipeWarp_DstY_0484D3", 0x484d3),
        ] {
            let v = c.ws(addr, 27)?;
            c.a.u16(name, v);
        }
    }
    Ok(())
}

/// assorted overworld tables
fn phase_assorted_overworld_tables(c: &mut Ctx) -> Result<()> {
    macro_rules! u16t {
        ($name:expr, $addr:expr, $n:expr) => {{
            let v = c.ws($addr, $n)?;
            c.a.u16($name, v);
        }};
    }
    macro_rules! u8t {
        ($name:expr, $addr:expr, $n:expr) => {{
            let v = c.bs($addr, $n)?;
            c.a.u8($name, v);
        }};
    }

    u16t!("kOwLevelsForcedMusicChange_048D74", 0x48d74, 11);
    u8t!("kOwSubmapMusic_048D8A", 0x48d8a, 7);
    u16t!("kOw_KoopaKidTeleportXYPos_048E49", 0x48e49, 6);
    u8t!("kOwTriggerSaveTiles_048F7F", 0x48f7f, 8);
    u16t!("kOwNoAutoMoveLevels_04906C", 0x4906c, 6);
    u8t!("kOwHardcodedPathLevel_049078", 0x49078, 10);
    u16t!("kOwHardcodedPathChocolateIsland2_049082", 0x49082, 2);
    u8t!("kOwHardcodedPathTiles_049086", 0x49086, 68);
    u8t!("kOwHardcodedPathDirs_0490CA", 0x490ca, 68);
    u8t!("kOwHardcodedPathStartIndex_04910E", 0x4910e, 10);
    u8t!("kOwExitLevelTiles_049426", 0x49426, 10);
    u16t!("kUpdateLevelName_DATA_049C91", 0x49c91, 31);
    u16t!("kUpdateLevelName_DATA_049CCF", 0x49ccf, 15);
    u16t!("kUpdateLevelName_DATA_049CED", 0x49ced, 13);
    u8t!("kOwExitSource_049964", 0x49964, 70);
    u8t!("kOwExitDest_0499AA", 0x499aa, 70);
    u8t!("kOwExitExtra_0499F0", 0x499f0, 28);
    u16t!("kOwExitLayerPosition_049A0C", 0x49a0c, 12);
    u8t!("kOwUnknownTableA_From_04A03C", 0x4a03c, 24);
    u16t!("kOwUnknownTableA_Alpha_04A054", 0x4a054, 24);
    u16t!("kOwUnknownTableA_XY_04A084", 0x4a084, 48);
    u8t!("kOwUnknownTableA_Direction_04A0E4", 0x4a0e4, 24);
    u8t!("kOwDirectionAfterBeatingLevel_04D678", 0x4d678, 113);
    u8t!("kOwSubmapTileset_04DC02", 0x4dc02, 7);
    u16t!("kLayer2EventData_Ptrs_04E359", 0x4e359, 121);

    let v = if c.b(0x5dd80)? != 0xff {
        c.bs(0x05DDA0, 96)?
    } else {
        Vec::new()
    };
    c.a.u8("kLmInitSaveData", v);
    u8t!("kInitializeSaveData_InitialOWPlayerPos", 0x9EF0, 22);
    u16t!("kOWSpr07_Smoke_DATA_04FC1E", 0x4FC1E, 4);
    u16t!("kLoadOverworldSprites_SubmapBooXPosOffset", 0x4F666, 3);
    u16t!("kLoadOverworldSprites_SubmapBooYPosOffset", 0x4F66C, 3);
    u8t!("kLoadLevelHeader_LevelMusicTable", 0x584DB, 8);

    // hack: two stray bytes appended to a contiguous table
    let mut v = c.bs(0xC9A7, 8)?;
    v.push(c.b(0xCA0C)?);
    v.push(c.b(0xCA13)?);
    c.a.u8("kLevelsThatTriggerCutscenes", v);
    Ok(())
}

/// ExGFX
fn phase_exgfx(c: &mut Ctx) -> Result<()> {
    {
        let super_addr = c.l(0xFF937)?;
        for (name, addr, size) in [
            ("kLmExgfx", 0xFF600u32, 128u32),
            ("kLmSuperExgfx", super_addr, 0x1000 - 0x100),
        ] {
            let mut r = Vec::new();
            if c.lunar_magic && addr != 0xffffff {
                for i in 0..size {
                    let p = c.l(addr + i * 3)?;
                    r.push(if p != 0 && p != 0xffffff {
                        get_comp_data(&c.rom, p)?
                    } else {
                        Vec::new()
                    });
                }
                r = remove_trail_empty(r);
            }
            c.a.packed(name, r);
        }
        let v = if c.lunar_magic {
            remove_trail_zero(c.bs(0xFF200, 1024)?)
        } else {
            Vec::new()
        };
        c.a.u8("kLmGraphicsRemapped", v);
    }
    Ok(())
}

/// Lunar Magic level loader
fn phase_lunar_magic_level_loader(c: &mut Ctx) -> Result<()> {
    {
        let lm_load_level = c.b(0x5D9A1)? == 0x22;
        let p = c.l(0x6F624)?;
        let v = if lm_load_level && p != 0xffffff {
            c.ws(p, 4096)?
        } else {
            Vec::new()
        };
        c.a.u16("kLmModifyMap16Ids", v);

        for (name, addr) in [
            ("kLm5DE00", 0x5DE00u32),
            ("kLm6FC00", 0x6FC00),
            ("kLm6FE00", 0x6FE00),
        ] {
            let v = if lm_load_level { c.bs(addr, 512)? } else { Vec::new() };
            c.a.u8(name, v);
        }

        let p = if lm_load_level {
            let q = c.l(0x5D9A2)?;
            c.l(q + 0x10BBDF - 0x10BB83)?
        } else {
            0
        };
        let v = if p != 0 { c.bs(p, 512)? } else { Vec::new() };
        c.a.u8("kLm10B8BC", v);

        let v = if lm_load_level { c.bs(0x3FE00, 512)? } else { Vec::new() };
        c.a.u8("kLmLevelData3FE00", v);

        for (name, ptr) in [("kLmLevelData5DC85", 0x5DC86u32), ("kLmLevelData5DC8A", 0x5DC8B)] {
            let v = if lm_load_level {
                let q = c.l(ptr)?;
                c.bs(q, 512)?
            } else {
                Vec::new()
            };
            c.a.u8(name, v);
        }

        let v = if lm_load_level {
            let q = c.l(0x5DC81)?;
            c.bs(q, 512)?
        } else {
            c.bs(0x5fe00, 0x200)?
        };
        c.a.u8("kLm5FE00", v);

        for (name, lm_ptr, vanilla) in [
            ("kLevelInfo_05F800", 0xde191u32, 0x5f800u32),
            ("kLevelInfo_05FA00", 0xde198, 0x5fa00),
            ("kLevelInfo_05FC00", 0xde19f, 0x5fc00),
        ] {
            let v = if lm_load_level {
                let q = c.l(lm_ptr)?;
                c.bs(q, 0x200)?
            } else {
                c.bs(vanilla, 0x200)?
            };
            c.a.u8(name, v);
        }
        if lm_load_level {
            c.lm.flags |= LM_LOAD_LEVEL;
        }
    }
    Ok(())
}

/// Lunar Magic map16 pointers
fn phase_lunar_magic_map16_pointers(c: &mut Ctx) -> Result<()> {
    {
        let arr: Vec<u32> = if c.lunar_magic {
            let mut b = 0x06F500u32;
            let half = c.b(0x6F54B)? != 0xB0;
            if half {
                b -= 2;
            }
            let mut arr = vec![
                (c.b(b + 0x57)? as u32) << 16 | ((c.w(b + 0x53)? + 0x1000) & 0xFFFF),
                (c.b(b + 0x60)? as u32) << 16 | (c.w(b + 0x5C)? ^ 0x8000),
                (c.b(b + 0x6B)? as u32) << 16 | ((c.w(b + 0x67)? + 1) & 0xFFFF),
                (c.b(b + 0x74)? as u32) << 16 | ((c.w(b + 0x70)? + 0x8001) & 0xFFFF),
            ];
            if !half {
                arr.extend_from_slice(&[
                    (c.b(b + 0x98)? as u32) << 16 | c.w(b + 0x94)?,
                    (c.b(b + 0xA1)? as u32) << 16 | ((c.w(b + 0x9D)? + 0x8000) & 0xFFFF),
                    (c.b(b + 0xAC)? as u32) << 16 | ((c.w(b + 0xA8)? + 1) & 0xFFFF),
                    (c.b(b + 0xB5)? as u32) << 16 | ((c.w(b + 0xB1)? + 0x8001) & 0xFFFF),
                ]);
            } else {
                c.warnings.push("Warning: Half map16".into());
                arr.extend_from_slice(&[0, 0, 0, 0]);
            }
            arr.push((c.b(b + 0x8A)? as u32) << 16 | ((c.w(b + 0x86)? + 0x1000) & 0xFFFF)); // TS
            arr
        } else {
            vec![0; 9]
        };

        for (i, &p) in arr.iter().enumerate() {
            let sz = get_rats_size(&c.rom, p)?;
            let v = c.ws(p, (sz / 2) as usize)?;
            let name = if i == 8 {
                "kMap16_TS".to_string()
            } else {
                format!("kMap16_{i}")
            };
            c.a.u16(&name, v);
        }
    }
    Ok(())
}

/// ExAnimation
fn phase_exanimation(c: &mut Ctx) -> Result<()> {
    {
        let mut lm_lvl_exanim: Vec<u32> = Vec::new();
        let mut lm_exanim_ranges: Vec<(u32, u32)> = Vec::new();
        if c.lunar_magic && c.b(0x0583AD)? == 0x22 {
            let hook = c.l(0x583AE)?;
            if c.bs(hook, 4)? != b"\xe2\x30\x8b\xa2" {
                return Err(format!("The Exanim file format is incorrect. {LM_HELP}"));
            }
            let exanim_ptr = (0x10C24E - 0x10C164) + hook;
            for i in 0..512u32 {
                let p = c.l(exanim_ptr + i * 3)?;
                lm_lvl_exanim.push(if p & 0x8000 == 0 { 0 } else { p });
                if p & 0x8000 != 0 {
                    let sz = calc_exanim_size(&c.rom, p)?;
                    lm_exanim_ranges.push((p, p + sz));
                }
            }
            c.lm.flags |= LM_EXANIM;
        }
        let mut v = Vec::new();
        for a in remove_trail_zero_u32(lm_lvl_exanim) {
            v.extend_from_slice(&pack_24(a));
        }
        c.a.u8("kLmLvlExAnim", v);
        c.a.blob("kLmExanimBlob", lm_exanim_ranges, &c.rom)?;
    }
    Ok(())
}

/// feature detection
fn phase_feature_detection(c: &mut Ctx) -> Result<()> {
    if c.lunar_magic {
        c.lm.flags |= LM_ENABLED;
    }
    let ow_decompress = c.bs(0xA149, 4)?;
    c.lm.flags |= match ow_decompress.as_slice() {
        b"\xea\xea\xea\xea" => LM_SKIP_OVERWORLD_DECOMPRESS,
        b"\x22\x00\xFC\x0E" => 0, // lm
        b"\x22\x28\xBA\x00" => 0, // orig
        other => {
            return Err(format!(
                "unrecognised overworld decompress patch at 0xA149: {other:02x?}"
            ))
        }
    };

    let checks: [(u32, u8, bool, u32); 12] = [
        // (addr, value, equal?, flag)
        (0x480D0, 0x60, true, LM_OVERWORLD_TILES_4BPP),
        (0xA5E1, 0xea, true, LM_COPY_512_COLORS),
        (0xAF71, 0x22, true, LM_WEIRD_PALETTE),
        (0xEF570, 0xc2, false, LM_SKIP_LOAD_PALETTE_HOOK),
        (0xAACE, 0x10, true, LM_4BPP_GFX),
        (0x05B15D, 0xea, true, LM_DONT_SET_YPOS_FOR_INTRO_MARCH),
        (0x5855C, 0x8d, true, LM_MUSIC_REG_TWEAK),
        (0xa045, 0x22, true, LM_TIDE_WATER_TWEAK),
        (0x194B6, 0x5c, true, LM_ENEMY_COLL_TWEAK),
        (0xa0a0, 0xea, true, LM_DONT_RESET_OW_PLAYERS_MAP),
        (0xAA8D, 0x08, false, LM_NON_STD_GFX_AA8D),
        (0x58E24, 0x8f, true, LM_TIMER_TWEAKS),
    ];
    for (addr, val, eq, flag) in checks {
        let b = c.b(addr)?;
        if (b == val) == eq {
            c.lm.flags |= flag;
        }
    }
    if c.bs(0xAA6B, 4)? != b"\x22\x28\xBA\x00" {
        c.lm.flags |= LM_GFX_UPLOAD;
    }
    if ow_decompress != b"\x22\x28\xBA\x00" {
        c.lm.flags |= LM_OW_4BPP_GFX;
    }
    if c.b(0x3BA26)? == 0 {
        c.lm.flags |= LM_NO_DEFAULT_SAVE_PROMPTS;
    }
    // Wall kick: slide along a wall and press B.
    if c.l(0xA2A1)? != 0x86F122 {
        c.lm.hacks |= HACK_WALLJUMP;
    }
    Ok(())
}

/// custom overworld palette
fn phase_custom_overworld_palette(c: &mut Ctx) -> Result<()> {
    {
        let mut r = Vec::new();
        if c.b(0xAD32)? == 0x22 {
            c.lm.flags |= LM_OW_PALETTE;
            let p = c.l(0xAD33)? - 0x10813F;
            let q = (c.b(p + 0x10815D)? as u32) << 16 | c.w(p + 0x108151)?;
            r = get_rats_bytes(&c.rom, q)?;
        }
        c.a.u8("kLmOverworldPal", r);
    }
    Ok(())
}

/// custom display message
fn phase_custom_display_message(c: &mut Ctx) -> Result<()> {
    {
        let flag = c.b(0x5B1A3)? == 0x22;
        if flag {
            c.lm.flags |= LM_CUSTOM_DISPLAY_MESSAGE;
        }
        let v = if flag {
            let p = c.l(0x3BC0B)?;
            get_rats_bytes(&c.rom, p)?
        } else {
            Vec::new()
        };
        c.a.u8("kLmDisplayMessage_Tab0", v);
        let v = if flag { c.ws(0x3BC7F, 8)? } else { Vec::new() };
        c.a.u16("kLmDisplayMessage_3BC7F", v);
        let v = if flag { c.ws(0x3BE80, 192)? } else { Vec::new() };
        c.a.u16("kLmDisplayMessage_3BE80", v);
        let mut r = Vec::new();
        if flag {
            for a in [0x3BB9Au32, 0x3BBA1, 0x3BBA6, 0x3BBAB, 0x3BBB0] {
                if c.b(a)? != 0xe0 {
                    return Err(format!("expected 0xe0 at {a:#x} in the display message patch"));
                }
                r.push(c.b(a + 1)?);
            }
        }
        c.a.u8("kLmDisplayMessage_Tab1", r);
    }
    Ok(())
}

/// custom title screen
fn phase_custom_title_screen(c: &mut Ctx) -> Result<()> {
    {
        if c.b(0x9c6f)? == 0x22 {
            c.lm.flags |= LM_CUSTOM_TITLE_SCREEN_DEMO;
        }
        let v = if c.lm.flags & LM_CUSTOM_TITLE_SCREEN_DEMO != 0 {
            let q = c.l(0x9c70)?;
            let p = c.l(q + 0x10F6B0 - 0x10F68D)? - 2;
            let n = get_rats_size(&c.rom, p)?;
            c.bs(p, n as usize)?
        } else {
            Vec::new()
        };
        c.a.u8("kLmTitleScreenMoves", v);
    }
    Ok(())
}

/// level names patch
fn phase_level_names_patch(c: &mut Ctx) -> Result<()> {
    {
        if c.b(0x48E81)? == 0x22 {
            c.lm.flags |= LM_LEVEL_NAMES_PATCH;
        }
        let v = if c.lm.flags & LM_LEVEL_NAMES_PATCH != 0 {
            let p = c.l(0x3BB57)?;
            let n = get_rats_size(&c.rom, p)?;
            c.bs(p, n as usize)?
        } else {
            Vec::new()
        };
        c.a.u8("kLmLevelNamesPatch", v);
    }
    Ok(())
}

/// compressed overworld layer1 and events
fn phase_compressed_overworld_layer1_and_events(c: &mut Ctx) -> Result<()> {
    {
        let v = if c.b(0x4d813)? == 0x5c {
            let p = (c.b(0x4d808)? as u32) << 16 | c.w(0x4d803)?;
            get_comp_data(&c.rom, p)?
        } else {
            Vec::new()
        };
        c.a.u8("kOwLayer1AndEvents", v);

        let v = if c.b(0x4d832)? == 0x5c {
            let p = (c.b(0x4d827)? as u32) << 16 | c.w(0x4d822)?;
            get_comp_data(&c.rom, p)?
        } else {
            Vec::new()
        };
        c.a.u8("kOwLayer1AndEvents2", v);
    }
    Ok(())
}

/// Lunar Magic level info
fn phase_lunar_magic_level_info(c: &mut Ctx) -> Result<()> {
    {
        let v = if c.lunar_magic && c.b(0xA140)? == 0x22 {
            c.lm.lvl_info_addr_other = (c.b(0xFFAC2)? as u32) << 16 | c.w(0xFFAB9)?;
            c.lm.lvl_info_addr = c.l(0xFF7FF)?;
            let addr = c.lm.lvl_info_addr;
            c.ws(addr, (512 + 8) * 16)?
        } else {
            Vec::new()
        };
        c.a.u16("kLmLvlInfo", v);
    }
    Ok(())
}

/// custom map16 backgrounds
fn phase_custom_map16_backgrounds(c: &mut Ctx) -> Result<()> {
    {
        let mut r = Vec::new();
        if c.lunar_magic {
            for i in 0..16u32 {
                let p = c.l(0xEFD50 + i * 3)?;
                r.push(if p != 0 {
                    c.bs(p, (0x8000 - (p & 0x7fff)) as usize)?
                } else {
                    Vec::new()
                });
            }
        }
        c.a.packed("kLmCustomMap16Bg", remove_trail_empty(r));
    }
    Ok(())
}

/// sprite extra size
fn phase_sprite_extra_size(c: &mut Ctx) -> Result<()> {
    {
        let mut r = Vec::new();
        if c.lunar_magic {
            let p = c.l(0xef30c)?;
            if p != 0xffffff {
                r = c.bs(p, 1024)?;
            }
        }
        c.a.u8("kLmSprExtraSize", r);
    }
    Ok(())
}

/// Every phase, in order, with the name a UI shows while it runs.
pub const PHASES: &[(&str, fn(&mut Ctx) -> Result<()>)] = &[
    ("graphics", phase_graphics),
    ("audio", phase_audio),
    ("map16 / palettes", phase_map16_palettes),
    ("levels", phase_levels),
    ("sprites", phase_sprites),
    ("overworld events", phase_overworld_events),
    ("Lunar Magic event tables", phase_lunar_magic_event_tables),
    ("Lunar Magic palettes", phase_lunar_magic_palettes),
    ("star pipe warps", phase_star_pipe_warps),
    ("assorted overworld tables", phase_assorted_overworld_tables),
    ("ExGFX", phase_exgfx),
    ("Lunar Magic level loader", phase_lunar_magic_level_loader),
    ("Lunar Magic map16 pointers", phase_lunar_magic_map16_pointers),
    ("ExAnimation", phase_exanimation),
    ("feature detection", phase_feature_detection),
    ("custom overworld palette", phase_custom_overworld_palette),
    ("custom display message", phase_custom_display_message),
    ("custom title screen", phase_custom_title_screen),
    ("level names patch", phase_level_names_patch),
    ("compressed overworld layer1 and events", phase_compressed_overworld_layer1_and_events),
    ("Lunar Magic level info", phase_lunar_magic_level_info),
    ("custom map16 backgrounds", phase_custom_map16_backgrounds),
    ("sprite extra size", phase_sprite_extra_size),
];

/// Run the whole extraction in one go. Equivalent to driving every phase in
/// `PHASES` and then `finish`; kept so callers that do not care about progress
/// need not spell out the loop.
pub fn extract(rom: Rom, include_rom: bool) -> Result<Extraction> {
    let mut c = Ctx::new(rom, include_rom)?;
    for (_, f) in PHASES {
        f(&mut c)?;
    }
    Ok(c.finish())
}
