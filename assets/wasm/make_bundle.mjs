#!/usr/bin/env node
// Zips one release into an offline bundle.
//
// A bundle is the manifest plus the files it names, both at the zip root, so an
// installer resolves the manifest's relative urls against zip entries exactly
// as it resolves them against a website. See spec/06-bundle.md in
// https://github.com/slash-proc/gwrg-dist-spec
//
// Usage:
//   node make_bundle.mjs --manifest dist/manifest.json --dir dist \
//       --out dist/smw-v1.0.0-bundle.zip
//   node make_bundle.mjs --manifest dist/manifest.json --dir dist --print-name

import { readFileSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { deflateRawSync } from "node:zlib";
import { dirname, join } from "node:path";

function arg(name, required = true) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1 || !process.argv[i + 1]) {
    if (required) { console.error(`missing --${name}`); process.exit(2); }
    return null;
  }
  return process.argv[i + 1];
}

/** Every file the manifest names, in a stable order. */
export function declaredFiles(manifest) {
  const names = [];
  for (const target of manifest.targets) for (const a of target.artifacts) names.push(a.url);
  for (const tool of manifest.tools) names.push(tool.binary.url);
  return [...new Set(names)].sort();
}

/** url -> [bytes, sha256], as the manifest declares them. */
function expected(manifest) {
  const sizes = new Map();
  for (const target of manifest.targets) {
    for (const a of target.artifacts) sizes.set(a.url, [a.bytes, a.sha256]);
  }
  for (const tool of manifest.tools) {
    sizes.set(tool.binary.url, [tool.binary.bytes, tool.binary.sha256]);
  }
  return sizes;
}

export function bundleName(manifest) {
  return `${manifest.project}-${manifest.source.ref}-bundle.zip`.toLowerCase();
}

// --- a minimal zip writer --------------------------------------------------
//
// Deliberately dependency-free: this repo's tooling has no runtime deps and a
// bundle is an archival format, so the fewer moving parts the better.

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function zip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, "utf8");
    const deflated = deflateRawSync(data, { level: 9 });
    // Stored beats deflate on already-compressed payloads; take whichever wins.
    const useStore = deflated.length >= data.length;
    const body = useStore ? data : deflated;
    const method = useStore ? 0 : 8;
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);          // version needed
    local.writeUInt16LE(0, 6);           // flags
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);          // time — fixed, so the zip is reproducible
    local.writeUInt16LE(0x21, 12);       // date — 1980-01-01
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBuf, body);

    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4);            // version made by
    dir.writeUInt16LE(20, 6);            // version needed
    dir.writeUInt16LE(0, 8);
    dir.writeUInt16LE(method, 10);
    dir.writeUInt16LE(0, 12);
    dir.writeUInt16LE(0x21, 14);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(body.length, 20);
    dir.writeUInt32LE(data.length, 24);
    dir.writeUInt16LE(nameBuf.length, 28);
    dir.writeUInt32LE(offset, 42);
    central.push(dir, nameBuf);

    offset += local.length + nameBuf.length + body.length;
  }

  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);

  return Buffer.concat([...chunks, centralBuf, end]);
}

// --- driver ----------------------------------------------------------------

const manifestPath = arg("manifest");
const srcDir = arg("dir");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

if (process.argv.includes("--print-name")) {
  console.log(bundleName(manifest));
  process.exit(0);
}

const outPath = arg("out", false) ?? join(srcDir, bundleName(manifest));
const sizes = expected(manifest);
const names = declaredFiles(manifest);

const entries = [{ name: "manifest.json", data: readFileSync(manifestPath) }];
for (const name of names) {
  const source = join(srcDir, name);
  if (!statSync(source, { throwIfNoEntry: false })?.isFile()) {
    console.error(`manifest names ${name}, which is not in ${srcDir}`);
    process.exit(1);
  }
  // A bundle that disagrees with its own manifest is worse than none: it fails
  // at install time, on someone else's machine.
  const data = readFileSync(source);
  const [wantBytes, wantHash] = sizes.get(name);
  if (data.length !== wantBytes) {
    console.error(`${name}: manifest says ${wantBytes} bytes, file is ${data.length}`);
    process.exit(1);
  }
  if (createHash("sha256").update(data).digest("hex") !== wantHash) {
    console.error(`${name}: sha256 does not match the manifest`);
    process.exit(1);
  }
  entries.push({ name, data });
}

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, zip(entries));
console.log(`make_bundle: wrote ${outPath} (${statSync(outPath).size} bytes)`);
console.log(`  manifest.json + ${names.join(", ")}`);
