# Conformance verification

Spec version 1. Implemented by `verify.mjs`, which is dependency-free and runs
unchanged in a browser, in CI, or in a code review.

The claim being enforced is **structural, not behavioural**. Rather than
auditing what a module does, the verifier checks what it *can* do, which is
decidable by reading the binary.

## Checks

| Check | Why |
|---|---|
| Import section is empty | The core claim. No host functions means no filesystem, network, clock, randomness or JS bridge. |
| Exports are *exactly* the declared ABI | Anything missing is broken; anything extra is unreviewed surface. |
| No start section | Nothing runs at instantiation time. |
| Declares its own, non-shared memory | An imported memory is host-controlled; a shared one is visible to other threads. |
| Bounded `max` on memory | Caps memory-exhaustion DoS at a value fixed in the binary. |
| Sections ordered, not duplicated | Two parsers must not be able to disagree about the same bytes. |
| No over-long LEB128 encodings | Same reason. This is a classic differential-parsing trick. |
| Module size cap | Bounds the parse itself. |

## Two independent enforcements

The verifier checks statically. Then `WebAssembly.instantiate` is called with
**no import object at all**, so a module that asked for anything fails to
instantiate. The browser enforces the same property the verifier asserts.

Neither is trusted on its own, and neither depends on the manifest.

## Build requirements this implies

- **No dependency may introduce an import.** In practice that means nothing
  touching `std::fs`, `std::time`, or `getrandom`. Pure-computation crates —
  image decoding, YAML parsing, compression — are fine, and are exactly the
  kind of crate a port should reuse rather than reimplement. You do not have to
  audit for this: a crate that drags in an import fails the gate and never
  reaches a release.
- **Keep `.cargo/config.toml`.** Its `--max-memory` link argument is what makes
  memory growth bounded. Without it the module declares unbounded growth and
  fails verification.
- **Do not add exports.** Changing the export set means changing the spec, the
  verifier, the host runner, the manifest generator and every consumer
  together.

## Running it

```console
$ node verify.mjs module.wasm
imports:  (none)
exports:  memory:memory, abi_version:func, alloc:func, ...
memory:   min=17 max=4096
PASS - module is conformant and structurally sandboxed.
```

`test.mjs` builds non-conformant modules by hand and asserts each is rejected,
so a PASS means something. Its fixtures are derived from the policy, so an ABI
change updates them all at once.
