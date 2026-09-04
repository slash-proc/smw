#!/usr/bin/env node
// Assembles the dist/ tree that GitHub Pages serves.
//
// Releases are the source of truth. This rebuilds the whole tree from them
// every time, so the site is a derived view that can be deleted and
// regenerated rather than state edited in place. See spec/01-distribution.md
// and spec/02-versions.md in https://github.com/slash-proc/gwrg-dist-spec
//
// Browsers cannot fetch GitHub release assets cross-origin, which is the
// entire reason this mirror exists. `gh` runs server-side in CI, where that
// restriction does not apply.
//
// Usage:
//   node build_dist.mjs --repo owner/name --out _site/dist --retain 5 \
//       [--require-tag v1.0.0] [--no-bundles]
//
// --local <dir> builds a one-version tree from a staged release directory
// instead of from the releases. That is how check.sh exercises the mirror, and
// the conformance checker with it, without cutting a release.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, rmSync, cpSync, existsSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCHEMA_VERSION = 1;

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 || !process.argv[i + 1] ? fallback : process.argv[i + 1];
}

const repo = arg("repo");
const out = arg("out");
const retain = Number(arg("retain", "5"));
const requireTag = arg("require-tag");
const local = arg("local");
const bundles = !process.argv.includes("--no-bundles");

if (!repo || !out) {
  console.error("usage: build_dist.mjs --repo owner/name --out _site/dist [--retain 5]");
  process.exit(2);
}

const gh = (args, opts = {}) =>
  execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts });

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * Newest first. Drafts are skipped; they are not published.
 *
 * A release created moments ago may not be listed yet, so this retries until it
 * appears. `requireTag` is the tag currently being published: without it an
 * empty answer is indistinguishable from a project that genuinely has no
 * releases.
 */
function listReleases(attempts = 6) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const raw = JSON.parse(gh([
      "release", "list", "--repo", repo, "--limit", "100",
      "--json", "tagName,publishedAt,isPrerelease,isDraft",
    ]));
    const rels = raw
      .filter((r) => !r.isDraft && r.publishedAt)
      .sort((a, b) => (a.publishedAt < b.publishedAt ? 1 : -1));
    const have = new Set(rels.map((r) => r.tagName));

    if (rels.length && (requireTag === null || have.has(requireTag))) return rels;
    if (attempt === attempts) {
      console.error(`gh returned ${raw.length} release(s); ${rels.length} published: ` +
        `${[...have].sort().join(", ") || "none"}`);
      return rels;
    }
    console.error(`${requireTag ? `${requireTag} not listed yet` : "no releases listed yet"};` +
      ` retrying in ${attempt * 5}s`);
    sleep(attempt * 5000);
  }
  return [];
}

/** Download one release asset. False when the release does not carry it. */
function fetchAsset(tag, name, dest) {
  try {
    gh(["release", "download", tag, "--repo", repo, "--pattern", name,
        "--dir", dest, "--clobber"]);
    return existsSync(join(dest, name));
  } catch {
    return false;
  }
}

/** Every file the manifest names, in a stable order. */
function declaredFiles(manifest) {
  const names = [];
  for (const target of manifest.targets) for (const a of target.artifacts) names.push(a.url);
  for (const tool of manifest.tools) names.push(tool.binary.url);
  return [...new Set(names)].sort();
}

/** Fetch a release's manifest and every file it declares. False if it has none. */
function download(tag, dest) {
  mkdirSync(dest, { recursive: true });
  if (!fetchAsset(tag, "manifest.json", dest)) return false;

  const manifest = JSON.parse(readFileSync(join(dest, "manifest.json"), "utf8"));
  for (const name of declaredFiles(manifest)) {
    if (name.includes("/") || name.startsWith(".")) {
      console.error(`${tag}: manifest declares a suspicious url ${JSON.stringify(name)}`);
      process.exit(1);
    }
    if (!fetchAsset(tag, name, dest)) {
      console.error(`${tag}: manifest names ${name}, which the release does not carry`);
      process.exit(1);
    }
  }
  return true;
}

function indexEntry(tag, release, manifest, bundle) {
  const target = manifest.targets[0];
  // Duplicated into the index so a version picker needs one fetch, not N+1.
  // The checker verifies these against the manifest they came from.
  const needsUserFiles = manifest.tools.some((t) => t.inputs.some((i) => i.required));
  return {
    tag,
    manifest: `${tag}/manifest.json`,
    publishedAt: release.publishedAt,
    prerelease: Boolean(release.isPrerelease),
    kind: target.kind,
    requiresAbi: { ...target.requiresAbi },
    needsUserFiles,
    ...(bundle ? { bundle } : {}),
  };
}

function pickLocal() {
  const manifestPath = join(local, "manifest.json");
  if (!existsSync(manifestPath)) {
    console.error(`${manifestPath} is missing — run make_manifest.mjs first`);
    process.exit(1);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  for (const name of declaredFiles(manifest)) {
    if (!existsSync(join(local, name))) {
      console.error(`${local}: manifest names ${name}, which is not there`);
      process.exit(1);
    }
  }
  // Marked prerelease: an unreleased local build is not a published version,
  // and saying otherwise in the index would be a lie a tool could act on.
  return [{
    tag: manifest.source.ref,
    release: { publishedAt: new Date().toISOString(), isPrerelease: true },
    manifest,
    dest: local,
  }];
}

const releases = local ? [] : listReleases();
if (!local && !releases.length) {
  console.error(`${repo} has no published releases`);
  process.exit(1);
}
if (!local && requireTag && !releases.some((r) => r.tagName === requireTag)) {
  console.error(`${repo} does not list ${requireTag}, the tag being published`);
  process.exit(1);
}

const staging = local ? null : mkdtempSync(join(tmpdir(), "gwrg-dist-"));
const picked = local ? pickLocal() : [];
let project = picked[0]?.manifest.project ?? null;
let title = picked[0]?.manifest.title ?? null;

for (const release of releases) {
  if (picked.length >= retain) break;
  const tag = release.tagName;
  const dest = join(staging, tag);
  if (!download(tag, dest)) {
    console.error(`skip ${tag}: no manifest.json attached`);
    rmSync(dest, { recursive: true, force: true });
    continue;
  }

  const manifest = JSON.parse(readFileSync(join(dest, "manifest.json"), "utf8"));
  if (manifest.schemaVersion !== SCHEMA_VERSION) {
    console.error(`skip ${tag}: schemaVersion ${manifest.schemaVersion}`);
    rmSync(dest, { recursive: true, force: true });
    continue;
  }
  // schemaVersion alone does not identify the shape: this project published
  // its own manifest format under schemaVersion 1 before adopting the spec,
  // and those releases parse fine and then lack every field used below. Check
  // for the shape itself and pass over anything that predates the move.
  if (!Array.isArray(manifest.tools) || !Array.isArray(manifest.targets)
      || !manifest.source || typeof manifest.source.ref !== "string") {
    console.error(`skip ${tag}: predates the distribution spec`);
    rmSync(dest, { recursive: true, force: true });
    continue;
  }
  if (manifest.source.ref !== tag) {
    console.error(`${tag}: manifest says it was built for ${manifest.source.ref}`);
    process.exit(1);
  }

  // The newest release settles the project identity; older ones must agree.
  if (project === null) { project = manifest.project; title = manifest.title; }
  else if (manifest.project !== project) {
    console.error(`${tag}: project ${manifest.project} != ${project}`);
    process.exit(1);
  }

  picked.push({ tag, release, manifest, dest });
  console.log(`include ${tag}`);
}

if (!picked.length) {
  // Not a failure. Every release may predate the spec, which is exactly the
  // state a project is in between adopting it and cutting the first tag that
  // carries the new shape. Publish no tree and let the caller deploy the page
  // on its own rather than failing a deploy that has nothing wrong with it.
  console.error("no release carries a spec manifest yet — publishing no dist tree");
  process.exit(0);
}

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const entries = [];
for (const { tag, release, manifest, dest } of picked) {
  // Only the files the manifest names go into the version directory; a bundle
  // staged alongside them belongs at the tree root.
  mkdirSync(join(out, tag), { recursive: true });
  cpSync(join(dest, "manifest.json"), join(out, tag, "manifest.json"));
  for (const name of declaredFiles(manifest)) {
    cpSync(join(dest, name), join(out, tag, name));
  }

  // The bundle is a release asset like any other; the mirror never builds one,
  // so what a user downloads offline is what the project published.
  let bundle = null;
  if (bundles) {
    const name = `${manifest.project}-${tag}-bundle.zip`.toLowerCase();
    if (local) {
      if (existsSync(join(local, name))) {
        cpSync(join(local, name), join(out, name));
        bundle = name;
      }
    } else if (fetchAsset(tag, name, out)) {
      bundle = name;
    }
    if (!bundle) console.error(`note ${tag}: no offline bundle for this version`);
  }
  entries.push(indexEntry(tag, release, manifest, bundle));
}

const index = {
  schemaVersion: SCHEMA_VERSION,
  project,
  title,
  repo,
  releasesUrl: `https://github.com/${repo}/releases`,
  retained: retain,
  versions: entries,
};

writeFileSync(join(out, "versions.json"), JSON.stringify(index, null, 2) + "\n");
if (staging) rmSync(staging, { recursive: true, force: true });

console.log(`\nbuild_dist: wrote ${out} with ${entries.length} version(s), latest ${entries[0].tag}`);
