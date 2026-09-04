#!/usr/bin/env bash
# Full local check, including byte-for-byte parity with the Python reference.
# Needs a Super Mario World (USA) ROM, which cannot be committed or shipped to CI.
#
#   ./check.sh /path/to/smw.sfc
set -euo pipefail
cd "$(dirname "$0")"

ROM="${1:-}"
# The tag a local dist tree is built under. A real one comes from the release
# being published; locally any placeholder does, since nothing is shipped.
TAG="${SMW_TAG:-v0.0.0}"

cargo build --release --locked --target wasm32-unknown-unknown --lib
node test.mjs
node verify.mjs target/wasm32-unknown-unknown/release/smw_restool.wasm

# The distribution gate. Stage a release exactly as CI does, mirror it into a
# dist/ tree, build the page around it, and run the GWRG spec's own conformance
# checker (vendored under conformance/) against the result over http. A tree
# that fails this must never be deployed, so failing here is the point.
echo; echo "== distribution conformance =="
rm -rf dist _dist
mkdir -p dist
cp target/wasm32-unknown-unknown/release/smw_restool.wasm dist/
node make_manifest.mjs --wasm dist/smw_restool.wasm --tag "$TAG" \
  --repo slash-proc/smw --out dist/manifest.json
sha256sum dist/smw_restool.wasm | tee dist/SHA256SUMS
node make_bundle.mjs --manifest dist/manifest.json --dir dist
node build_dist.mjs --local dist --repo slash-proc/smw --out _dist
DIST_TREE=_dist ./build-page.sh
node test-conformance.mjs site

if [[ -z "$ROM" ]]; then
  echo; echo "No ROM given - skipping output parity check."
  echo "Run './check.sh /path/to/smw.sfc' to compare against the Python reference."
  exit 0
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

echo; echo "== Python reference =="
( cd "$tmp" && PYTHONPATH="$OLDPWD/.." python3 "$OLDPWD/../restool.py" --rom "$(realpath "$ROM")" )

echo "== wasm module =="
cargo build --release --locked --target wasm32-unknown-unknown --lib
node extract.mjs target/wasm32-unknown-unknown/release/smw_restool.wasm "$tmp/wasm.dat" "$ROM"

if cmp "$tmp/smw_assets.dat" "$tmp/wasm.dat"; then
  echo; echo "PASS - wasm output is byte-identical to the Python reference."
else
  echo; echo "FAIL - output differs from the Python reference."
  exit 1
fi

# Record the hashes of this run so the published manifest can state what a
# correct extraction produces. Only written from a run that just passed parity,
# so the file cannot claim a hash the Python did not also produce.
node record-reference.mjs reference.json "$tmp/wasm.dat" "$ROM"

echo; echo "== ABI behaviour =="
node test-abi.mjs "$ROM"
