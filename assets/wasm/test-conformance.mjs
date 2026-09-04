#!/usr/bin/env node
// Runs the GWRG distribution spec's own conformance checker against a locally
// built site, over http, which is the same path a browser takes.
//
// The checker and its schemas are vendored verbatim under conformance/ (see
// conformance/README.md), so this gates on the same code as the public checker
// at https://slash-proc.github.io/gwrg-dist-spec/ and needs no network.
//
//   node test-conformance.mjs [siteDir]      # default: site

import { createServer } from "node:http";
import { readFileSync, statSync, existsSync } from "node:fs";
import { join, normalize } from "node:path";
import { check } from "./conformance/check.js";

const siteDir = process.argv[2] ?? "site";
const schemaDir = new URL("./conformance/schema/", import.meta.url);

if (!existsSync(join(siteDir, "dist", "versions.json"))) {
  console.error(`${siteDir}/dist/versions.json is missing — build the dist tree first`);
  process.exit(2);
}

const server = createServer((req, res) => {
  const path = decodeURIComponent(req.url.split("?")[0]);
  // Zip- and url-path traversal is the same hazard: normalise, then refuse
  // anything that climbed out of the root.
  const rel = normalize(path).replace(/^(\.\.[/\\])+/, "").replace(/^\/+/, "");

  let body;
  if (rel.startsWith("schema/")) {
    try { body = readFileSync(new URL(rel.slice("schema/".length), schemaDir)); }
    catch { res.writeHead(404); return res.end("no"); }
  } else {
    const file = join(siteDir, rel);
    if (!statSync(file, { throwIfNoEntry: false })?.isFile()) {
      res.writeHead(404); return res.end("no");
    }
    body = readFileSync(file);
  }
  res.writeHead(200, {
    "content-type": "application/octet-stream",
    "content-length": String(body.length),
  });
  res.end(req.method === "HEAD" ? undefined : body);
});

await new Promise((r) => server.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${server.address().port}`;

const index = JSON.parse(readFileSync(join(siteDir, "dist", "versions.json"), "utf8"));

// hash: true downloads every declared file and verifies its sha256, which is
// the whole point of publishing one.
const result = await check(index.repo, {
  base: `${origin}/dist/`,
  schemaBase: `${origin}/schema/`,
  hash: true,
});

server.close();

for (const c of result.checks) {
  const mark = { ok: "  ok  ", warn: "  warn", error: "  FAIL", info: "  note" }[c.level];
  console.log(`${mark} ${c.label}${c.detail ? ` — ${c.detail}` : ""}`);
}

const { errors, warnings, passed, conformant } = result.summary;
console.log(`\n${passed} passed, ${warnings} warning(s), ${errors} error(s)`);
console.log(conformant ? "CONFORMANT" : "NOT CONFORMANT");
process.exit(conformant ? 0 : 1);
