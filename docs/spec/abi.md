# Extractor ABI, version 1

Spec version 1. Project-independent: any repo publishing an asset extractor
under this spec implements exactly this contract.

A conforming module **imports nothing**. Everything below is an export.

## Exports

```
memory                                          the module's linear memory
abi_version() -> u32                            the ABI this module implements

alloc(len: u32) -> u32                          reserve len bytes, returns offset
input_clear()                                   discard registered input files
input_add(ptr: u32, len: u32) -> u32            register one input, returns index

run(flags: u32) -> u32                          whole run; 0 = ok
run_begin(flags: u32) -> u32                    start a stepped run; 0 = ok
run_step() -> u32                               0 = done, 1 = more, else error

stage_count() -> u32                            total stages
stage_index() -> u32                            stages completed so far
stage_name_ptr(i: u32) -> u32                   UTF-8 name of stage i
stage_name_len(i: u32) -> u32

output_count() -> u32                           files produced
output_name_ptr(i: u32) -> u32                  UTF-8 file name of output i
output_name_len(i: u32) -> u32
output_ptr(i: u32) -> u32                       bytes of output i
output_len(i: u32) -> u32

error_ptr() -> u32                              message; empty when status is 0
error_len() -> u32
warnings_ptr() -> u32                           newline-separated diagnostics
warnings_len() -> u32
```

The export set is checked for **exact** equality by the verifier. A missing
export is a broken module; an extra one is unreviewed surface. Both fail.

## Calling sequence

```js
x.input_clear();
for (const file of files) {
  const ptr = x.alloc(file.length);
  // alloc can grow memory, so re-read the buffer for every file
  new Uint8Array(x.memory.buffer, ptr, file.length).set(file);
  x.input_add(ptr, file.length);
}

if (x.run_begin(flags) !== 0) throw readError();
while (x.run_step() === 1) {
  report(x.stage_index(), x.stage_count(), stageName(x.stage_index()));
}
for (let i = 0; i < x.output_count(); i++) { /* read output i */ }
```

`run(flags)` is exactly that loop with no reporting, for hosts that
do not want progress. Both routes must produce identical output; a module that
implements them as separate code paths has made a mistake.

**Re-read `memory.buffer` after any call that can grow memory.** Growing
detaches every `ArrayBuffer` captured beforehand, so a view taken before `run`
is unusable after it.

Ownership: `input_add` takes ownership of the buffer at `ptr`, which must have
come from `alloc`. The host must not reuse it afterwards. `run`/`run_begin`
consume the registered list, so a second run starts from an empty one.

## Inputs

Inputs are a **list**, because a project may need more than one file: Zelda 3
needs a base ROM and, for a translated build, a per-language ROM as well. A
project that takes one file registers one.

A module decides which input plays which role **from the content of the file** —
its hash, its header, its size — and never from the order the host registered
them in or from a host-supplied name. There is no name parameter on `input_add`
for exactly this reason: a name is a claim the host makes about a file, and a
module that trusted it could be steered into treating one file as another. The
manifest names the roles so a host can tell a user what to supply, and marks
which are `required`; a module that does not find a required role fails with a
message saying what is missing.

## Status codes

| Code | Meaning |
|---|---|
| 0 | success (or, from `run_step`, the run has finished) |
| 1 | from `run_step` only: more work remains, call again |
| ≥2 | error; a message is at `error_ptr`/`error_len` |

Projects assign their own error codes from 2 upward and document them in their
`PROJECT.md`. A host should show the message, not the number.

## Flags

`flags` is a bitfield. Bits are project-specific except that **unrecognised
bits must be rejected** with an error rather than ignored — otherwise a newer
host silently gets an older module's behaviour while believing it asked for
something else. Projects declare their bits in the manifest's `flags` object.

## Stages, progress and cancellation

Progress works by **returning control**, not by calling out.

This is forced by the security policy rather than chosen. A module that imports
nothing cannot invoke a host callback. And its memory is non-shared, so the
host cannot watch a counter while `run` is executing — a `WebAssembly.Memory`
that is not `shared` cannot be viewed from another thread at all. Shared memory
would additionally require cross-origin isolation headers, which GitHub Pages
cannot set.

So the work is divided into named stages. Between `run_step` calls the host has
control and can render progress, and **cancellation is simply not calling
`run_step` again** — plus terminating the Worker to reclaim the memory. There is
no cancel flag in this ABI and there cannot be one.

Stage names are shown to users. They should be short, human-readable, and
distinct.

## Versioning

`abi_version()` returns the spec version the module implements. A host that
does not recognise the value must refuse to drive the module rather than guess.
The manifest states the same number; if the two disagree, the binary wins.
