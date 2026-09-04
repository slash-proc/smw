// The page's own logic. This is a reference consumer of the extractor spec: it
// uses the same verify.mjs and extract.mjs that a consuming web builder
// does, so if the ABI drifts, this page breaks in CI before anything else does.
//
// Every string that came from the module or the manifest is inserted with
// textContent, never innerHTML. Both are data we fetched, not code we trust.

import { verify } from "./verify.mjs";
import { SUPPORTED, applyStatic, localeText, onLocaleChange, setLocale, locale, t } from "./i18n.js";

const $ = (id) => document.getElementById(id);
// The manifest is the entry point and it names the module; the page does not
// hardcode the filename, because a consuming tool cannot. This is the same
// fetch sequence a third-party web tool performs against this Pages site --
// which is the distribution channel, since release assets are not
// CORS-fetchable (GWRG distribution spec, spec/01-distribution.md).
//
// The published route is the spec's own: read dist/versions.json, take
// versions[0], resolve its manifest against that file. build-page.sh writes
// which urls to use into config.json. The copy deployed beside this page is
// the last fallback.
const DEFAULT_MANIFEST = "manifest.json";
const RUN_TIMEOUT_MS = 120_000;

// `files` holds one entry per input role, keyed by role id:
// { bytes, sha1, name, variant }. A role the user has not filled is absent.
const state = {
  wasmBytes: null, tool: null, manifest: null, reference: null,
  files: new Map(), lastResults: null,
};

const setStatus = (el, cls, text) => {
  el.hidden = false;
  el.className = `status ${cls}`;
  el.textContent = text;
};

const hex = (buf) =>
  [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

async function digest(algo, bytes) {
  return hex(await crypto.subtle.digest(algo, bytes));
}

const roles = () => state.tool?.inputs ?? [];
// Flag bits are per-project and declared by the manifest, never hardcoded here.
// An option the manifest does not declare is a reserved bit and must stay zero.
const optionBit = (id) => {
  const opt = (state.tool?.options ?? []).find((o) => o.id === id);
  return opt ? 1 << opt.bit : 0;
};
const requiredRoles = () => roles().filter((r) => r.required);

// --- load and verify the module -------------------------------------------
//
// This happens silently. Verification is not a feature the user asked for and
// they cannot act on its details; it either passes, in which case saying so is
// noise, or it fails, in which case the page cannot work and must say why.

// Revalidate rather than trusting the cache. A manifest names its module and
// that module's hash, so a stale manifest fetches a stale module -- and because
// the pair is internally consistent the hash check passes, leaving the
// staleness to surface later as a confusing verification failure. This has
// happened; do not remove the cache option.
const FRESH = { cache: "no-cache" };

/**
 * Fetches a manifest and the module it describes, and checks both. Returns the
 * loaded pair, or throws with the reason this source is unusable.
 */
async function loadFrom(manifestUrl) {
  const manRes = await fetch(manifestUrl, FRESH).catch(() => null);
  if (!manRes || !manRes.ok) throw new Error(t().fatal.noManifest);
  const manifest = await manRes.json();

  // Refuse a schema or a processor revision this page does not implement,
  // rather than guessing at fields that may have changed meaning.
  if (manifest.schemaVersion !== 1) {
    throw new Error(`manifest declares schemaVersion ${manifest.schemaVersion}, this page reads 1`);
  }
  const tool = manifest.tools?.[0];
  if (!tool) throw new Error("manifest declares no tools");
  if (tool.processor?.type !== "wasm" || tool.processor?.version !== 1) {
    throw new Error(`unsupported processor ${tool.processor?.type}/${tool.processor?.version}`);
  }

  const binary = tool.binary;
  const moduleUrl = new URL(binary.url ?? binary.file, new URL(manifestUrl, location.href));
  // Content-address the request so a new module can never be served from a
  // cache entry belonging to an older one. The hash is checked below either
  // way; this stops the wrong bytes arriving in the first place.
  if (binary.sha256) moduleUrl.searchParams.set("v", binary.sha256.slice(0, 16));
  const wasmRes = await fetch(moduleUrl, FRESH);
  if (!wasmRes.ok) throw new Error(`could not fetch ${binary.file} (${wasmRes.status})`);
  const bytes = new Uint8Array(await wasmRes.arrayBuffer());

  // The manifest says which bytes it describes. If they disagree, the manifest
  // is describing something other than what we are about to run, and the honest
  // response is to refuse rather than to prefer one of them.
  const sha256 = await digest("SHA-256", bytes);
  if (sha256 !== binary.sha256) throw new Error(t().fatal.mismatch);

  // The real gate: decided by reading the binary, not by reading the manifest.
  const result = verify(bytes);
  if (!result.ok) throw new Error(t().fatal.unsafe(result.errors.join("; ")));

  return { manifest, tool, bytes, sha256 };
}

/**
 * The spec's resolution path: one fetch of the index, then the newest entry's
 * manifest resolved against it. Returns a manifest url, or throws.
 */
async function resolveNewest(versionsUrl) {
  const res = await fetch(versionsUrl, FRESH);
  if (!res.ok) throw new Error(`could not fetch ${versionsUrl} (${res.status})`);
  const index = await res.json();
  if (index.schemaVersion !== 1) {
    throw new Error(`index declares schemaVersion ${index.schemaVersion}, this page reads 1`);
  }
  // Newest first is what makes versions[0] the latest.
  const newest = index.versions?.[0];
  if (!newest) throw new Error(`${versionsUrl} lists no versions`);
  return new URL(newest.manifest, new URL(versionsUrl, location.href)).href;
}

/**
 * Hashes of a verified reference run, published beside this page. Not part of
 * the distribution manifest -- the spec has no field for it -- so it is fetched
 * separately and its absence is not an error.
 */
async function loadReference() {
  try {
    const res = await fetch("reference.json", FRESH);
    if (res.ok) state.reference = await res.json();
  } catch { /* no reference run recorded */ }
}

async function loadModule() {
  try {
    let config = {};
    try {
      const cfg = await fetch("config.json", FRESH);
      if (cfg.ok) config = await cfg.json();
    } catch { /* no config: fall back to the copy beside this page */ }

    // Sources, in order of preference. The published tree is what a
    // third-party consumer reads, and reading it here means a release reaches
    // users without redeploying this page. The copy deployed beside the page is
    // the safety net.
    //
    // The fallback covers more than an unreachable mirror. The page and the
    // published module are versioned independently: the page ships from main,
    // the dist tree only gains a version on a tag, so between an ABI change and
    // the next release the published module is genuinely older than this page
    // and fails its checks. That is the verifier doing its job, not a broken
    // page, and the right response is to use the module this page shipped with
    // rather than to show a dead page until someone cuts a tag.
    const sources = [];
    const reasons = [];
    if (config.manifestUrl) {
      sources.push(config.manifestUrl);
    } else if (config.versionsUrl) {
      try {
        sources.push(await resolveNewest(config.versionsUrl));
      } catch (e) {
        reasons.push(`${config.versionsUrl}: ${e.message ?? e}`);
      }
    }
    if (!sources.includes(DEFAULT_MANIFEST)) sources.push(DEFAULT_MANIFEST);

    let loaded = null;
    for (const url of sources) {
      try {
        loaded = await loadFrom(url);
        break;
      } catch (e) {
        reasons.push(`${url}: ${e.message ?? e}`);
      }
    }
    if (!loaded) throw new Error(reasons.join("; "));
    if (reasons.length) {
      // Not shown to the user: they cannot act on it and the page works. It
      // belongs in the console for whoever is wondering why the tag is behind.
      console.info(`using the module beside this page; ${reasons.join("; ")}`);
    }

    await loadReference();

    const { manifest, tool, bytes, sha256 } = loaded;
    state.wasmBytes = bytes;
    state.tool = tool;
    state.manifest = manifest;
    state.moduleSha256 = sha256;

    buildRoleInputs();
    // The info box doubles as the check's result: it appears only on the far
    // side of the hash match and the verifier, and it is drawn from the
    // manifest, so it says the right thing for any project using this spec.
    $("about").hidden = false;
    if (manifest.source?.repo) {
      $("repo-link").href = `https://github.com/${manifest.source.repo}`;
    }
    renderLocalised();
  } catch (e) {
    const fatal = $("fatal");
    fatal.hidden = false;
    fatal.textContent = t().fatal.cannotRun(e.message ?? e);
    document.querySelectorAll(".drop").forEach((d) => d.classList.add("disabled"));
  }
}

// --- localised rendering ---------------------------------------------------
//
// Everything the language switch has to redraw lives here, so switching is one
// call and cannot leave half the page in the previous language.

function renderLocalised() {
  applyStatic();
  const tool = state.tool;
  if (!tool) return;

  const title = localeText(tool.title) || state.manifest?.title || "";
  $("title").textContent = t().app.heading(state.manifest?.title ?? title);
  document.title = $("title").textContent;

  const outNames = tool.outputs.map((o) => o.filename).join(", ");
  const primary = requiredRoles()[0] ?? roles()[0];
  $("lede-text").textContent = t().app.lede(localeText(primary?.label), outNames);

  // A single-role project reads better with the role's own name as the section
  // heading ("Your ROM") than with a generic plural.
  $("input-heading").textContent =
    roles().length === 1 ? localeText(roles()[0].label) : t().input.heading;

  $("io-out").textContent = outNames;
  renderIoInput();

  for (const role of roles()) {
    const box = document.getElementById(`role-${role.id}`);
    if (!box) continue;
    const roleLabel = box.querySelector(".role-label");
    if (roleLabel) roleLabel.textContent = localeText(role.label);
    const opt = box.querySelector(".role-optional");
    if (opt) opt.textContent = t().input.optional;
    const desc = box.querySelector(".role-desc");
    if (desc) desc.textContent = localeText(role.description);
    const prompt = box.querySelector(".drop-prompt");
    const got = state.files.get(role.id);
    prompt.textContent = got ? got.name : t().input.choose;
    if (got) renderFileStatus(role, got);
  }

  // Re-render results in the new language rather than leaving stale text.
  if (state.lastResults) showResults(state.lastResults);
}

function renderIoInput() {
  const chosen = roles().map((r) => state.files.get(r.id)).filter(Boolean);
  const mark = $("io-in-mark");
  if (chosen.length === 0) {
    const primary = requiredRoles()[0] ?? roles()[0];
    $("io-in").textContent = primary
      ? `${localeText(primary.label)} (${(primary.extensions ?? []).join(", ")})`
      : "";
    mark.textContent = "";
    mark.className = "mark";
    return;
  }
  $("io-in").textContent = chosen.map((c) => c.name).join(", ");
  // One mark for the whole input: everything recognised, or something not.
  const allKnown = chosen.every((c) => c.variant);
  mark.textContent = allKnown ? "✓" : "!";
  mark.className = `mark ${allKnown ? "ok" : "warn"}`;
}

// --- 1. the inputs ---------------------------------------------------------

function buildRoleInputs() {
  const host = $("roles");
  host.replaceChildren();

  // With a single role the section heading already names it, so repeating the
  // label directly underneath is noise.
  const showHeads = roles().length > 1;

  for (const role of roles()) {
    const box = document.createElement("div");
    box.className = "role";
    box.id = `role-${role.id}`;

    if (showHeads) {
      const head = document.createElement("div");
      head.className = "role-head";
      const label = document.createElement("span");
      label.className = "role-label";
      head.append(label);
      if (!role.required) {
        const opt = document.createElement("span");
        opt.className = "role-optional";
        head.append(opt);
      }
      box.append(head);
    }

    if (role.description && showHeads) {
      const desc = document.createElement("p");
      desc.className = "role-desc";
      box.append(desc);
    }

    const drop = document.createElement("label");
    drop.className = "drop";
    drop.htmlFor = `file-${role.id}`;
    const input = document.createElement("input");
    input.type = "file";
    input.id = `file-${role.id}`;
    if (role.extensions?.length) input.accept = role.extensions.join(",");
    const prompt = document.createElement("span");
    prompt.className = "drop-prompt";
    drop.append(input, prompt);
    box.append(drop);

    const status = document.createElement("div");
    status.className = "status";
    status.id = `status-${role.id}`;
    status.hidden = true;
    box.append(status);

    host.append(box);

    input.addEventListener("change", (e) => acceptFile(role, e.target.files[0]));
    for (const ev of ["dragenter", "dragover"]) {
      drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("over"); });
    }
    for (const ev of ["dragleave", "drop"]) {
      drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("over"); });
    }
    drop.addEventListener("drop", (e) => acceptFile(role, e.dataTransfer.files[0]));
  }
}

function renderFileStatus(role, got) {
  const status = document.getElementById(`status-${role.id}`);
  if (got.variant) {
    setStatus(status, "ok", t().input.recognised(got.name, localeText(got.variant.label)));
  } else {
    // An unrecognised file is almost always a ROM hack, which by definition
    // cannot match a known hash. Rather than making the user find and
    // understand a checkbox, accept it and say what we assumed. If it is not
    // the right game at all, the extraction fails on its own.
    setStatus(status, "warn", t().input.unrecognised(got.name, localeText(role.label)));
  }
}

async function acceptFile(role, file) {
  const status = document.getElementById(`status-${role.id}`);
  state.files.delete(role.id);
  updateGo();

  if (!file) {
    status.hidden = true;
    renderLocalised();
    return;
  }
  if (role.maxBytes && file.size > role.maxBytes) {
    setStatus(status, "bad", t().input.tooLarge(file.name));
    renderIoInput();
    return;
  }

  setStatus(status, "busy", t().input.reading(file.name));
  const bytes = new Uint8Array(await file.arrayBuffer());
  const sha1 = (await digest("SHA-1", bytes)).toUpperCase();
  const variant = (role.variants ?? []).find((v) => v.sha1 === sha1) ?? null;

  const got = { bytes, sha1, name: file.name, variant };
  state.files.set(role.id, got);

  document.querySelector(`#role-${role.id} .drop-prompt`).textContent = file.name;
  renderFileStatus(role, got);
  renderIoInput();
  updateGo();
}

function updateGo() {
  const ready = requiredRoles().every((r) => state.files.has(r.id));
  $("go").disabled = !ready;
}

// --- 2. run ----------------------------------------------------------------

function progressBar() {
  const wrap = document.createElement("div");
  wrap.className = "bar";
  const fill = document.createElement("div");
  wrap.append(fill);
  return { wrap, fill };
}

async function run() {
  const status = $("run-status");
  const results = $("results");
  const warnList = $("warnings");
  results.hidden = warnList.hidden = true;
  warnList.replaceChildren();
  $("downloads").replaceChildren();
  $("go").disabled = true;
  state.lastResults = null;

  const { wrap, fill } = progressBar();
  status.hidden = false;
  status.className = "status busy";
  status.replaceChildren(document.createTextNode(t().run.starting), wrap);

  // Registration order follows the manifest's role order, but the module
  // identifies each file by content, so the order is a convenience only.
  const ordered = roles().map((r) => state.files.get(r.id)).filter(Boolean);
  const anyUnrecognised = ordered.some((f) => !f.variant);

  const worker = new Worker("worker.js", { type: "module" });
  // The ABI has no cancel flag, so this is what a timeout means: stop the
  // thread the module is running on.
  const timer = setTimeout(() => {
    worker.terminate();
    setStatus(status, "bad", t().run.timedOut);
    updateGo();
  }, RUN_TIMEOUT_MS);

  worker.onmessage = async (ev) => {
    const m = ev.data;
    if (m.type === "progress") {
      const pct = Math.round((m.stage / m.stages) * 100);
      fill.style.width = `${pct}%`;
      status.firstChild.textContent = t().run.progress(pct, m.name, m.stage + 1, m.stages);
      return;
    }
    clearTimeout(timer);
    worker.terminate();
    updateGo();

    if (m.type === "error") {
      setStatus(status, "bad", m.message);
      return;
    }
    state.lastResults = m;
    await showResults(m);
  };

  worker.postMessage({
    wasmBytes: state.wasmBytes,
    inputs: ordered.map((f) => f.bytes),
    flags: anyUnrecognised ? optionBit("noHashCheck") : 0,
    expectedOutputs: state.tool.outputs.map((o) => o.filename),
    maxOutputBytes: state.tool.limits?.maxOutputBytes,
  });
}

async function showResults({ outputs, warnings }) {
  const status = $("run-status");
  const warnList = $("warnings");
  const results = $("results");
  setStatus(status, "ok", t().run.done(outputs.length));

  warnList.replaceChildren();
  if (warnings.length) {
    warnList.hidden = false;
    for (const w of warnings) {
      const li = document.createElement("li");
      li.textContent = w;                       // module-supplied: text, never markup
      warnList.append(li);
    }
  }

  const reference = state.reference;
  const list = $("downloads");
  list.replaceChildren();
  for (const out of outputs) {
    const data = new Uint8Array(out.data);
    const sha256 = await digest("SHA-256", data);

    const li = document.createElement("li");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([data], { type: "application/octet-stream" }));
    a.download = out.name;
    a.textContent = t().results.download(out.name);
    const meta = document.createElement("div");
    meta.className = "meta";

    // If this repo published the hashes of a verified reference run, and the
    // user gave the same inputs, the output should match exactly. The verdict
    // is the part that means anything to a reader; the hash itself is 64
    // characters of noise until someone actually wants to compare it, so it
    // stays behind a click.
    const expected = matchesReferenceInput(reference)
      ? reference.outputs.find((o) => o.name === out.name)
      : null;

    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "hash-toggle";
    if (!expected) {
      toggle.textContent = t().results.hash;
    } else if (expected.sha256 === sha256) {
      toggle.textContent = t().results.hashMatches;
      toggle.classList.add("ok");
    } else {
      toggle.textContent = t().results.hashDiffers;
      toggle.classList.add("bad");
    }

    const hash = document.createElement("code");
    hash.className = "hash-value";
    hash.hidden = true;
    hash.textContent = sha256;
    toggle.addEventListener("click", () => { hash.hidden = !hash.hidden; });

    meta.append(`${t().results.bytes(data.length)} · `, toggle, hash);

    li.append(a, meta);
    list.append(li);
  }
  results.hidden = false;
}

/** True when the files the user supplied are the ones the reference run used. */
function matchesReferenceInput(reference) {
  if (!reference) return false;
  // Spec 1 references record either a single `input` or a list of `inputs`.
  const want = reference.inputs ?? (reference.input ? [reference.input] : []);
  if (want.length === 0) return false;
  const got = [...state.files.values()].map((f) => f.sha1).sort();
  const expect = want.map((i) => i.sha1).sort();
  return got.length === expect.length && got.every((h, i) => h === expect[i]);
}

// --- wiring ----------------------------------------------------------------

const langSelect = $("lang");
for (const l of SUPPORTED) {
  const opt = document.createElement("option");
  opt.value = l.code;
  opt.textContent = l.label;          // languages are named in their own language
  langSelect.append(opt);
}
langSelect.value = locale();
langSelect.addEventListener("change", (e) => setLocale(e.target.value));

$("go").addEventListener("click", run);

// The "?" is a disclosure, not a tooltip: it has to work on a touch screen.
const why = $("why");
why.addEventListener("click", () => {
  const box = $("why-text");
  box.hidden = !box.hidden;
  why.setAttribute("aria-expanded", String(!box.hidden));
});

onLocaleChange(renderLocalised);
document.documentElement.lang = locale();
loadModule();
