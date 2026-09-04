#!/usr/bin/env node
// Emits dist/<tag>/manifest.json for one release, in the shape the GWRG
// distribution spec defines (https://github.com/slash-proc/gwrg-dist-spec,
// spec/03-manifest.md).
//
// The manifest is the entry point, not the trust root. It carries the module's
// sha256, so a consumer that trusts the manifest's origin can check it got the
// right bytes -- but everything security-relevant (imports, exports, memory
// bounds) is re-derived from the binary by `verify.mjs` and must agree. A
// manifest that claimed a module imported nothing would not make it so.
//
// Everything that can be derived from the built module is derived: its size,
// its hash and its memory ceiling come out of the bytes being published.
//
// Usage:
//   node make_manifest.mjs --wasm dist/smw_restool.wasm --tag v1.0.0 \
//       --repo slash-proc/smw --commit "$GITHUB_SHA" --out dist/manifest.json

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { basename, dirname } from "node:path";
import { verify, DEFAULT_POLICY } from "./verify.mjs";

const SCHEMA_VERSION = 1;

const PROJECT = "smw";
const TITLE = "Super Mario World";

// The Retro-Go SD firmware ABI this build targets. The spec treats
// requiresAbi as advisory whenever the device binary is produced rather than
// published (spec/03-manifest.md): the real requirement is carried in the
// header of the produced file and a host reads it from there.
const REQUIRES_ABI = { version: 2, minSize: 824 };

const TARGET = {
  id: "gnw-retro-go",
  platform: "game-and-watch",
  label: "Game & Watch (Retro-Go SD)",
  kind: "homebrew",
};

// Localised strings are {en, fr, de} objects. `en` is the base and is always
// present; a consumer falls back to it for any locale it has no entry for.
const loc = (en, fr, de) => ({ en, fr, de });

const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

function arg(name, required = true) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1 || !process.argv[i + 1]) {
    if (required) {
      console.error(`missing --${name}`);
      console.error("usage: make_manifest.mjs --wasm <module.wasm> --tag <tag>" +
        " --repo <owner/name> --commit <sha> --out <manifest.json>");
      process.exit(2);
    }
    return null;
  }
  return process.argv[i + 1];
}

const wasmPath = arg("wasm");
const outPath = arg("out");
const tag = arg("tag", false) ?? process.env.GITHUB_REF_NAME ?? "v0.0.0";
const repo = arg("repo", false) ?? process.env.GITHUB_REPOSITORY ?? "slash-proc/smw";
const commit = arg("commit", false) ?? process.env.GITHUB_SHA ??
  execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();

const bytes = new Uint8Array(readFileSync(wasmPath));

// The same gate the host applies. A module that fails it must never reach a
// manifest, because a manifest is a claim that these bytes are runnable.
const result = verify(bytes);
if (!result.ok) {
  console.error("refusing to publish a non-conformant module:");
  for (const e of result.errors) console.error(`  - ${e}`);
  process.exit(1);
}

const file = basename(wasmPath);

const manifest = {
  schemaVersion: SCHEMA_VERSION,
  project: PROJECT,
  title: TITLE,
  source: { repo, commit, ref: tag },

  tools: [
    {
      id: "smw-assets",
      processor: { type: "wasm", version: 1 },
      title: loc(
        "Super Mario World asset extraction",
        "Extraction des ressources de Super Mario World",
        "Super Mario World Ressourcen-Extraktion",
      ),
      // The four fields a host must check before instantiating. `url` is a
      // plain filename, resolved beside this manifest, so the same manifest
      // works from the Pages mirror and from an offline bundle.
      binary: {
        file,
        url: file,
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      },
      limits: {
        maxMemoryPages: DEFAULT_POLICY.maxMemoryPages,
        maxOutputBytes: MAX_OUTPUT_BYTES,
      },
      options: [
        {
          id: "noHashCheck",
          bit: 0,
          default: false,
          label: loc(
            "Accept a modified ROM",
            "Accepter une ROM modifiée",
            "Ein verändertes ROM akzeptieren",
          ),
        },
        {
          id: "noIncludeRom",
          bit: 1,
          default: false,
          label: loc(
            "Leave the ROM data out of the asset pack",
            "Exclure les données de la ROM du pack de ressources",
            "ROM-Daten nicht in das Ressourcenpaket aufnehmen",
          ),
        },
      ],
      // Role is resolved by the module from file content, never from order or
      // a host-supplied name; these entries exist so a UI can tell the user
      // what to supply and reject an obviously wrong file before spending a run.
      inputs: [
        {
          id: "base",
          required: true,
          repeatable: false,
          label: loc(
            "Super Mario World ROM",
            "ROM de Super Mario World",
            "Super Mario World ROM",
          ),
          extensions: [".sfc", ".smc"],
          maxBytes: 8 * 1024 * 1024,
          variants: [
            {
              id: "us",
              label: loc(
                "Super Mario World (USA)",
                "Super Mario World (USA)",
                "Super Mario World (USA)",
              ),
              sha1: "6B47BB75D16514B6A476AA0C73A683A2A4C18765",
              bytes: 512 * 1024,
            },
          ],
          // A Lunar Magic hack cannot match a known hash by construction, so an
          // unrecognised file is still worth trying.
          acceptsModified: true,
        },
      ],
      outputs: [
        { id: "assets", filename: "smw_assets.dat", maxBytes: MAX_OUTPUT_BYTES },
      ],
    },
  ],

  targets: [
    {
      ...TARGET,
      requiresAbi: REQUIRES_ABI,
      artifacts: [],
      uses: [{ tool: "smw-assets", outputs: ["assets"], required: true }],
    },
  ],
};

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(manifest, null, 2) + "\n");

const tool = manifest.tools[0];
console.log(`make_manifest: wrote ${outPath}`);
console.log(`  project=${manifest.project} title=${manifest.title} ref=${tag}`);
console.log(`  ${tool.binary.file} ${tool.binary.bytes} bytes sha256=${tool.binary.sha256.slice(0, 16)}…`);
console.log(`  outputs: ${tool.outputs.map((o) => o.filename).join(", ")}`);
