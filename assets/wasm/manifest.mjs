#!/usr/bin/env node
// Emits the release manifest that a consuming tool reads to discover, verify
// and drive this project's extractor.
//
// The manifest is the entry point, not the trust root. It carries the module's
// sha256, so a consumer that trusts the manifest's origin can check it got the
// right bytes -- but everything security-relevant (imports, exports, memory
// bounds) is re-derived from the binary by `verify.mjs` and must agree. A
// manifest that claimed a module imported nothing would not make it so.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { verify, DEFAULT_POLICY } from "./verify.mjs";

const [wasmPath, outPath] = process.argv.slice(2);
if (!outPath) {
  console.error("usage: manifest.mjs <module.wasm> <manifest.json>");
  process.exit(2);
}

const bytes = new Uint8Array(readFileSync(wasmPath));
const result = verify(bytes);
if (!result.ok) {
  console.error("refusing to publish a non-conformant module:");
  for (const e of result.errors) console.error(`  - ${e}`);
  process.exit(1);
}

// Output hashes are a function of (input x options), so they cannot be stated
// unconditionally. `check.sh` records the hashes of a real reference run into
// reference.json; when that exists we publish it, and when it does not we
// publish nothing rather than a hash we cannot stand behind.
const REFERENCE = "reference.json";
const reference = existsSync(REFERENCE) ? JSON.parse(readFileSync(REFERENCE, "utf8")) : null;

const env = process.env;
const isTag = env.GITHUB_REF_TYPE === "tag";
const manifest = {
  schemaVersion: 1,
  // The project-independent extractor spec this repo implements. A consumer
  // keyed to spec 1 knows what every field below means.
  spec: 1,
  project: "smw",
  title: "Super Mario World",
  source: {
    repo: env.GITHUB_REPOSITORY ?? null,
    commit: env.GITHUB_SHA ?? null,
    ref: env.GITHUB_REF_NAME ?? null,
    workflow: env.GITHUB_RUN_ID
      ? `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`
      : null,
  },
  docs: {
    readme: "assets/wasm/README.md",
    spec: "docs/spec/",
  },
  tools: [
    {
      id: "smw-assets",
      kind: "asset-extractor",
      title: "Super Mario World asset extraction",
      // Human-readable requirements: what the user must supply and what they
      // get back. A UI can show this verbatim.
      readme: "assets/wasm/PROJECT.md",

      // What the consumer must check before running the module.
      module: {
        file: wasmPath.split("/").pop(),
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        // Fetch the module from the same directory as this manifest. Release
        // assets are deliberately not used here: they are not CORS-fetchable
        // from a browser (see docs/spec/distribution.md), so a consuming web
        // tool cannot read them. The release URL below is the archival copy of
        // the identical bytes, for humans and non-browser consumers.
        url: wasmPath.split("/").pop(),
        releaseUrl: env.GITHUB_REPOSITORY && isTag
          ? `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/releases/download/${env.GITHUB_REF_NAME}/${wasmPath.split("/").pop()}`
          : null,
      },

      // The declared contract. A consumer re-derives this from the binary and
      // compares; the manifest is a convenience, never the source of truth.
      abi: {
        version: 1,
        imports: result.info.imports,
        exports: result.info.exports.map((e) => ({ name: e.name, kind: e.kind })),
        memory: result.info.memories,
      },
      policy: {
        allowImports: DEFAULT_POLICY.allowImports,
        allowStartSection: DEFAULT_POLICY.allowStartSection,
        maxMemoryPages: DEFAULT_POLICY.maxMemoryPages,
      },

      // Exactly one input file, chosen from the accepted variants below. The
      // module identifies which variant it was given by hash and enforces this
      // itself; the manifest copy lets a UI reject the wrong file up front,
      // before spending a run.
      input: {
        description: "Super Mario World (USA) SNES ROM",
        extensions: [".sfc", ".smc"],
        maxBytes: 8 * 1024 * 1024,
        variants: [
          {
            id: "us",
            label: "Super Mario World (USA)",
            sha1: "6B47BB75D16514B6A476AA0C73A683A2A4C18765",
            bytes: 512 * 1024,
          },
        ],
        // Lunar Magic hacks are accepted only with noHashCheck set, because by
        // construction they do not match any known hash.
        acceptsModified: true,
      },

      outputs: [
        {
          filename: "smw_assets.dat",
          description: "Asset pack consumed by the Super Mario World port",
        },
      ],

      // Hashes of a real run, or null. See the comment above.
      reference,

      limits: {
        maxOutputBytes: 16 * 1024 * 1024,
        // Advisory: lets a host size a Worker timeout. Cancellation is Worker
        // termination -- the ABI has no cancel flag and cannot have one.
        typicalRuntimeMs: 15,
      },

      flags: { noHashCheck: 1, noIncludeRom: 2 },
    },
  ],
};

writeFileSync(outPath, JSON.stringify(manifest, null, 2) + "\n");
console.log(`wrote ${outPath}`);
console.log(`  sha256 ${manifest.tools[0].module.sha256}`);
console.log(`  reference run: ${reference ? "present" : "absent (no ROM available at build time)"}`);
