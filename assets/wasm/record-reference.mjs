#!/usr/bin/env node
// Records the hashes of a verified extraction into reference.json, which
// manifest.mjs publishes so consumers can state what a correct run produces.
//
// Run only by check.sh, immediately after a run has been confirmed
// byte-identical to the Python reference. Generating it any other way would
// mean publishing a hash for output nobody checked.

import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename } from "node:path";

const [romPath, outPath, refPath] = process.argv.slice(2);
if (!refPath) {
  console.error("usage: record-reference.mjs <rom> <output.dat> <reference.json>");
  process.exit(2);
}

const sha = (algo, buf) => createHash(algo).update(buf).digest("hex");
const rom = readFileSync(romPath);
const out = readFileSync(outPath);

const reference = {
  input: {
    variant: "us",
    sha1: sha("sha1", rom).toUpperCase(),
    bytes: rom.length,
  },
  flags: 0,
  outputs: [
    { name: "smw_assets.dat", bytes: out.length, sha256: sha("sha256", out) },
  ],
};

writeFileSync(refPath, JSON.stringify(reference, null, 2) + "\n");
console.log(`wrote ${refPath} (${reference.outputs[0].sha256})`);
