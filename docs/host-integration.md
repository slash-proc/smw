# Host integration

Requirements for a tool that runs extractor modules. These are requirements,
not tips: the module sandbox does not cover any of them.

The module cannot reach the outside world, but **everything it hands back is a
value it chose** — lengths, file names, messages. Treat all of it as untrusted
input. This is where the residual risk in the design lives.

## Required

**Verify before instantiating.** Run `verify.mjs` on the bytes, then call
`WebAssembly.instantiate` with **no import object at all**. The second is not
redundant: it makes the engine enforce what the verifier asserted.

**Check the module against its manifest.** Hash the bytes you fetched and
compare with the manifest's `sha256`. If they disagree, refuse — do not prefer
one over the other. Then re-derive the ABI from the binary; the manifest is a
convenience, never the source of truth.

**Bound every length before allocating.** `output_len()` is a `u32` the module
chooses. Compare against the manifest's declared ceiling and reject an absurd
claim rather than discovering it when the tab dies. Check that `ptr + len` is
within `memory.buffer` before constructing a view.

**Re-read `memory.buffer` after any call that can grow memory.** Growing
detaches every `ArrayBuffer` captured beforehand. A view taken before `run` is
unusable after it.

**Treat module-supplied strings as text, never markup or paths.**
- Warnings and error messages: insert with `textContent`. Never `innerHTML`.
  Rendering them as HTML is XSS in your own origin.
- Output names: validate against a strict pattern — a plain file name, no
  separators, no `..`, no control characters — *and* against the output list
  the manifest declares. The manifest decides what a legitimate run produces;
  the module does not get to name its own destination.

**Run it in a Worker with a timeout.** The ABI has no cancellation flag and
cannot have one (see [spec/abi.md](spec/abi.md)). Terminating the Worker is the
only way to stop a run, and the only way to reclaim its memory.

**Reject unknown ABI and spec versions.** If `abi_version()` or the manifest's
`spec` is a number you do not implement, refuse rather than guessing.

## Recommended

**Report progress from the stepped path.** Call `run_begin` then `run_step` in
a loop, reading `stage_index()` and `stage_name_ptr/len` between steps. Drive
the stepped path even when you do not display progress, so the incremental
route is the one your tests cover rather than a second, less-travelled one.

**Show the reference verdict, not the hash.** When the manifest carries a
`reference` run for the input the user supplied, compare and tell them whether
it matched. The hash itself is 64 characters of noise until someone wants to
compare it.

## Reference implementations

A host registers each file with `input_add` before calling `run`, and must not
label them: which file plays which role is decided by the module from the file's
own content. The manifest's `inputs` array names the roles and says which are
required, so a UI can ask for the right files and refuse an obviously wrong one
before spending a run.

`extract.mjs` in this repo does all of the above and is meant to be copied.
`page/app.js` is a complete consumer built on it; `test-page.mjs` drives that
page in a real browser.

One warning from experience: `verify.mjs` and `extract.mjs` are loaded directly
by browsers as well as run under node. Node-only constructs in them — a
shebang, a bare `process.argv` — throw at import time and take the importing
page down *silently*, with no error visible anywhere. Both have happened here.
Guard them, and test the page in an actual browser.
