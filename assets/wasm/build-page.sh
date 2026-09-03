#!/usr/bin/env bash
# Assembles the GitHub Pages site into site/.
#
# The page is a consumer of the same verify.mjs and extract.mjs the web builder
# uses -- they are copied in, not reimplemented -- so publishing the page from
# the same CI run that builds the module keeps the two in step by construction.
set -euo pipefail
cd "$(dirname "$0")"

WASM="target/wasm32-unknown-unknown/release/smw_restool.wasm"
[[ -f "$WASM" ]] || { echo "build the module first: cargo build --release --target wasm32-unknown-unknown --lib" >&2; exit 1; }

rm -rf site
mkdir -p site
cp page/index.html page/style.css page/app.js page/worker.js site/
cp verify.mjs extract.mjs site/

# These files are loaded directly by the browser. Node-only constructs in them
# fail at import time and take the whole page down silently, which is a much
# worse failure than a build error -- so make it a build error. Both of these
# have bitten this page already.
for f in site/verify.mjs site/extract.mjs site/app.js site/worker.js; do
  if head -c 2 "$f" | grep -q '#!'; then
    echo "$f starts with a shebang; browsers cannot parse it" >&2
    exit 1
  fi
  if grep -n 'process\.' "$f" | grep -qv 'typeof process'; then
    if ! grep -q 'typeof process !== "undefined"' "$f"; then
      echo "$f uses process.* without a typeof guard; it will throw in a browser" >&2
      exit 1
    fi
  fi
done
cp "$WASM" site/
node manifest.mjs site/smw_restool.wasm site/manifest.json

# Nothing here is Jekyll, and Jekyll would swallow files it does not recognise.
touch site/.nojekyll

echo "site/ ready ($(du -sh site | cut -f1))"
