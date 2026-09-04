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
cp page/index.html page/style.css page/app.js page/worker.js page/i18n.js site/
cp verify.mjs extract.mjs site/

# These files are loaded directly by the browser. Node-only constructs in them
# fail at import time and take the whole page down silently, which is a much
# worse failure than a build error -- so make it a build error. Both of these
# have bitten this page already.
for f in site/verify.mjs site/extract.mjs site/app.js site/worker.js site/i18n.js; do
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
node make_manifest.mjs --wasm site/smw_restool.wasm --out site/manifest.json

# Hashes of a verified reference run. Not part of the distribution manifest --
# the spec has no field for them -- so the page fetches this separately and
# works without it.
[[ -f reference.json ]] && cp reference.json site/

# The published dist/ tree, when one has been built. Serving it under the page
# root is what makes <pages>/dist/versions.json the address a third-party
# installer reads, with the conversion page still at the site root.
if [[ -n "${DIST_TREE:-}" ]]; then
  [[ -d "$DIST_TREE" ]] || { echo "DIST_TREE=$DIST_TREE is not a directory" >&2; exit 1; }
  cp -r "$DIST_TREE" site/dist
fi

# Where the page reads its manifest from.
#
# MANIFEST_URL, when set, names one manifest directly -- a plain
# dist/<tag>/manifest.json on this Pages site, never a release asset (not
# CORS-fetchable) and never the retired `dist` branch. When it is not set and a
# dist tree is present, the page follows the spec's own route instead: fetch
# dist/versions.json, take versions[0], resolve its manifest against it. Either
# way the copy deployed beside the page is the fallback.
VERSIONS_URL="${VERSIONS_URL:-}"
if [[ -z "$VERSIONS_URL" && -f site/dist/versions.json ]]; then
  VERSIONS_URL="dist/versions.json"
fi
{
  echo "{"
  [[ -n "${MANIFEST_URL:-}" ]] && printf '  "manifestUrl": "%s",\n' "$MANIFEST_URL"
  printf '  "versionsUrl": "%s"\n' "$VERSIONS_URL"
  echo "}"
} > site/config.json
if [[ -n "${MANIFEST_URL:-}" ]]; then
  echo "page reads its manifest from: $MANIFEST_URL"
elif [[ -n "$VERSIONS_URL" ]]; then
  echo "page resolves its manifest through: $VERSIONS_URL"
else
  echo "page reads the manifest deployed beside it"
fi

# Nothing here is Jekyll, and Jekyll would swallow files it does not recognise.
touch site/.nojekyll

echo "site/ ready ($(du -sh site | cut -f1))"
