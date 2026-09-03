# Security model

Spec version 1. What running a stranger's extractor module does and does not
put at risk.

## The problem

A user has a proprietary ROM. A web tool needs to turn it into an asset pack.
The conversion logic is written by whoever ported the game — not by the tool's
author — and it must run on the user's machine, on the user's file.

The tool's author cannot audit every project's extractor, and should not have
to trust them. So the question is not "is this code well behaved?" but "what is
this code *able* to do?"

## The claim

**A module that imports nothing cannot reach anything.**

WebAssembly has no ambient authority. A module affects the outside world only
by calling a function the host gave it. With an empty import section there are
no such functions: no filesystem, no network, no clock, no randomness, no JS
bridge, not even a host-supplied memory. It can compute, and it can write into
its own linear memory. That is all — not because we reviewed the code, but
because the capability does not exist.

This is decidable by reading the binary, which is what makes it usable at
scale. `verify.mjs` decides it in a few hundred dependency-free lines that a
consuming tool can run itself. See [verification.md](verification.md).

Compare the alternatives:

- **Pyodide** — ~10 MB, installs wheels from PyPI at runtime, hands Python a
  live `js` bridge. `import js` reaches `fetch`, cookies and the DOM, so a
  hostile extraction script is equivalent to XSS in the host page's origin.
- **WASI** — smaller, but non-empty. You reason about whether `path_open` is
  reachable and whether your virtual filesystem shim is airtight. Sound, but a
  judgement call per module, and the guarantee moves into code you wrote.
- **Zero imports** — nothing to reason about.

## What this does *not* protect against

The value is in knowing where the line is.

- **Correctness.** A conformant module can return garbage, or a deliberately
  corrupt output file. Zero imports bounds the *blast radius* to the output; it
  does not make the output trustworthy. That trust comes from the source repo,
  reproducible builds, and published reference hashes.
- **Resource use.** It can spin forever, or allocate up to its declared cap.
  Run it in a Worker with a timeout; terminating the Worker is the only
  cancellation this design has.
- **The manifest.** It is published by the same repo as the module, so it is
  not independent evidence. Re-derive the ABI from the binary and compare.
  Never trust the manifest's claims about the module over the module itself.
- **The host.** This is the real residual risk and it is not in the module at
  all. Lengths, names and messages coming out of a module are attacker-chosen
  values; a host that renders them as HTML or uses them as filesystem paths has
  a vulnerability the sandbox cannot help with. See
  [../host-integration.md](../host-integration.md).
- **Discovery.** Whatever decides "this URL is the legitimate extractor for
  this project" is a trust boundary this spec does not close. A loose repo
  allowlist defeats everything downstream. See [distribution.md](distribution.md).

## Threats deliberately out of scope

A malicious output flashed to target hardware. For the devices this pattern was
built for — an STM32-class handheld with no radio, written over SWD by a tool
that only copies bytes — the realistic worst case is a bricked device that gets
reflashed, and the attack requires the user to have already chosen to run a
hostile extractor. It is not defended against here. A target with network
access would change that assessment.
