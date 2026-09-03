# SMW extractor: project specifics

The portable contract is in [`docs/spec/`](../../docs/spec/). This file is what
is particular to Super Mario World.

## Input

The ABI takes a list of files. SMW declares one role, and supplying anything
other than exactly one file is refused.

| Role | Required | | |
|---|---|---|---|
| `base` | yes | one SNES ROM | |

Accepted variants of `base`:

| Variant | SHA-1 | Size |
|---|---|---|
| Super Mario World (USA) | `6B47BB75D16514B6A476AA0C73A683A2A4C18765` | 524,288 |

A ROM whose hash is not listed is accepted only with the `noHashCheck` flag,
which is what a Lunar Magic hack requires — by construction it cannot match a
known hash. Hosts should set this automatically for an unrecognised file rather
than exposing it as a control; it is not a decision a user can make usefully.

Lunar Magic ROMs must be version 3.33. Anything else is refused with an
explanation.

## Output

| File | |
|---|---|
| `smw_assets.dat` | asset pack consumed by the Super Mario World port |

Reference run, from the USA ROM with default flags: 880,156 bytes, SHA-256
`86274eb42561664d68710b8912294dd6d3cc84c4e4a7cbe9d26a8ca6256cc6b6`. Published
in `reference.json`, which is written **only** by `check.sh` immediately after a
run has been confirmed byte-identical to the Python — so it cannot claim a hash
nobody checked.

## Flags

| Bit | Name | |
|---|---|---|
| 0 | `noHashCheck` | accept a ROM whose hash is unknown (Lunar Magic) |
| 1 | `noIncludeRom` | omit the source ROM from the output |

Unrecognised bits are rejected rather than ignored.

## Status codes

| Code | |
|---|---|
| 1 | extraction failed; message explains |
| 2 | unrecognised flag bits |
| 3 | `run_step` called without `run_begin` |
| 4 | wrong number of input files registered |

## Provenance and coverage

`assets/restool.py`, `compile_resources.py` and `util.py` are the reference
implementation. They are **not** dead code — they are the oracle the port is
checked against, and they must keep working.

Parity is verified four ways, all producing the same bytes: the Python, the
native CLI, the one-shot wasm path, and the stepped wasm path.

**Only the vanilla US path is exercised.** `LUNAR_MAGIC` is false for a vanilla
ROM, so a large fraction of `extract.rs` — every Lunar Magic branch — is ported
but never runs in any test. If you touch that code, get an LM 3.33 ROM and diff
against the Python before trusting it.

The parity check needs a copyrighted ROM, so it cannot run on a public CI
runner. It is gated behind `vars.HAVE_SMW_ROM` plus a `SMW_ROM_BASE64` secret
and skips when unset; maintainers run `./check.sh <rom>` locally. Everything
that does not need a ROM — build, verifier suite, conformance, browser smoke
test — runs on every push.
