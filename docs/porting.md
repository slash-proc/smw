# Porting another project to this pattern

The security machinery is project-independent. What is project-specific is the
extraction itself, and it scales with the original.

## Copy unchanged

`verify.mjs`, `extract.mjs`, `test.mjs`, `test-page.mjs`, `build-page.sh`, the
`page/` directory and `.github/workflows/wasm-extractor.yml`. Adjust names, not
logic. Everything under `docs/spec/` describes the contract you are
implementing; copy it or link to it.

## Steps

1. **Get a byte-exact oracle first.** Before writing any Rust, run the existing
   script on a real input and record the output hash. Byte-for-byte parity
   against real data is the only thing that makes a port of this kind
   trustworthy; without it you are guessing. This is the step that made the SMW
   port safe and it is the one worth insisting on.

2. **Port the extraction to Rust behind the ABI in [spec/abi.md](spec/abi.md).**
   Keep the original script — it is your oracle, not dead code.

   Reuse crates freely. Statically linking `image` or a YAML parser is nothing
   like Pyodide's runtime `micropip install`: the code ends up inside the
   hashed binary, so what runs is settled at build time. The only constraint is
   that a crate must not introduce a wasm import, which in practice means
   nothing touching `std::fs`, `std::time` or `getrandom`. You do not have to
   audit for this — a crate that drags in an import fails the gate.

3. **Divide the work into named stages.** `PHASES` in `extract.rs` is a list of
   `(name, fn(&mut Ctx) -> Result<()>)`. Hosts step through them to report
   progress, and the names are shown to users, so make them short and
   meaningful. Anything crossing a stage boundary lives in `Ctx`.

4. **Keep `.cargo/config.toml`.** Its `--max-memory` link argument is what makes
   memory growth bounded; without it the module declares unbounded growth and
   fails verification.

5. **Adjust `manifest.mjs`** for the project's input variants, outputs and
   flags, and `record-reference.mjs` for its output names.

6. **Publish to GitHub Pages as well as releases.** Release assets are not
   CORS-fetchable, so Pages is the channel a web tool can actually read. See
   [spec/distribution.md](spec/distribution.md).

## Sizing the job

The SMW extractor was ~1,300 lines of stdlib-only Python with no auxiliary data
files, and became ~1,700 lines of Rust.

Something like zelda3's is substantially larger: ~7,000 lines, Pillow and
PyYAML, and a `tables/` tree of yaml/png/bin inputs that has to be embedded in
the module rather than read from disk. The security machinery still copies over
unchanged; only step 2 grows.

Multiple languages are an input *variant* question, not a multi-input one: one
input file, several accepted hashes, and the module reports which it matched.
