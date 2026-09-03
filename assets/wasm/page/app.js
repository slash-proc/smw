// The page's own logic. This is a reference consumer of the extractor spec: it
// uses the same verify.mjs and extract.mjs that a consuming web builder
// does, so if the ABI drifts, this page breaks in CI before anything else does.
//
// Every string that came from the module or the manifest is inserted with
// textContent, never innerHTML. Both are data we fetched, not code we trust.

import { verify } from "./verify.mjs";

const $ = (id) => document.getElementById(id);
// The manifest is the entry point and it names the module; the page does not
// hardcode the filename, because a consuming tool cannot. This is the same
// fetch sequence a third-party web tool performs against this Pages site --
// which is the distribution channel, since release assets are not
// CORS-fetchable. See docs/spec/distribution.md.
// Overridden at build time by build-page.sh. In a published build this points
// at the tag-pinned manifest on the dist branch, so the page fetches its
// extractor the same way any other consumer would.
const DEFAULT_MANIFEST = "manifest.json";
const RUN_TIMEOUT_MS = 120_000;

const state = { wasmBytes: null, tool: null, rom: null, romSha1: null, variant: null };

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

function row(table, label, value, mono = false) {
  const tr = table.insertRow();
  tr.insertCell().textContent = label;
  const td = tr.insertCell();
  td.textContent = value;
  if (mono) td.className = "mono";
}

// --- load and verify the module -------------------------------------------
//
// This happens silently. Verification is not a feature the user asked for and
// they cannot act on its details; it either passes, in which case saying so is
// noise, or it fails, in which case the page cannot work and must say why.

async function loadModule() {
  try {
    let manifestUrl = DEFAULT_MANIFEST;
    try {
      const cfg = await fetch("config.json");
      if (cfg.ok) manifestUrl = (await cfg.json()).manifestUrl || manifestUrl;
    } catch { /* no config: fall back to the copy beside this page */ }

    // The published build reads the tag-pinned manifest from the dist branch.
    // If that is unreachable -- offline, or the branch not yet created -- fall
    // back to the copy deployed beside this page rather than showing a dead
    // page. Whichever one is used, the module is hash-checked and verified.
    let manRes = await fetch(manifestUrl).catch(() => null);
    if ((!manRes || !manRes.ok) && manifestUrl !== DEFAULT_MANIFEST) {
      manifestUrl = DEFAULT_MANIFEST;
      manRes = await fetch(manifestUrl).catch(() => null);
    }
    if (!manRes || !manRes.ok) throw new Error("could not fetch the extractor manifest");
    const manifest = await manRes.json();

    const tool = manifest.tools?.[0];
    if (!tool) throw new Error("manifest declares no tools");
    if (manifest.spec !== 1) throw new Error(`manifest declares spec ${manifest.spec}, this page reads spec 1`);

    const moduleUrl = new URL(tool.module.url ?? tool.module.file, new URL(manifestUrl, location.href));
    const wasmRes = await fetch(moduleUrl);
    if (!wasmRes.ok) throw new Error(`could not fetch ${tool.module.file} (${wasmRes.status})`);
    const bytes = new Uint8Array(await wasmRes.arrayBuffer());

    // The manifest says which bytes it describes. If they disagree, the
    // manifest is describing something other than what we are about to run,
    // and the honest response is to refuse rather than to prefer one of them.
    const sha256 = await digest("SHA-256", bytes);
    if (sha256 !== tool.module.sha256) {
      throw new Error("the extractor does not match its manifest");
    }

    // The real gate: decided by reading the binary, not by reading the manifest.
    const result = verify(bytes);
    if (!result.ok) throw new Error(`the extractor failed its safety checks: ${result.errors.join("; ")}`);

    state.wasmBytes = bytes;
    state.tool = tool;

    // The info box doubles as the check's result: it appears only on the far
    // side of the hash match and the verifier, and it is drawn from the
    // manifest, so it says the right thing for any project using this spec.
    state.inputLabel = `${tool.input.description} (${tool.input.extensions.join(", ")})`;
    $("io-in").textContent = state.inputLabel;
    $("io-out").textContent = tool.outputs.map((o) => o.filename).join(", ");
    $("about").hidden = false;

    // Provenance belongs in the footer, for the handful of people who want it.
    const line = $("module-line");
    line.hidden = false;
    line.textContent =
      `${tool.module.file} · ${bytes.length.toLocaleString()} bytes · SHA-256 ${sha256}` +
      (manifest.source?.commit ? ` · built from ${manifest.source.commit.slice(0, 12)}` : "");

    $("file").disabled = false;
  } catch (e) {
    const fatal = $("fatal");
    fatal.hidden = false;
    fatal.textContent = `This page cannot run: ${e.message ?? e}`;
    $("drop").classList.add("disabled");
  }
}

// --- 2. the input ----------------------------------------------------------

async function acceptFile(file) {
  const status = $("file-status");
  const tool = state.tool;
  state.rom = state.variant = null;
  $("go").disabled = true;

  $("io-in").textContent = state.inputLabel ?? "";
  $("io-in-mark").textContent = "";

  if (!file || !tool) return;
  if (file.size > tool.input.maxBytes) {
    setStatus(status, "bad",
      `That file is too large to be a Super Mario World ROM.`);
    return;
  }

  setStatus(status, "busy", `Reading ${file.name}…`);
  const bytes = new Uint8Array(await file.arrayBuffer());
  const sha1 = (await digest("SHA-1", bytes)).toUpperCase();

  state.rom = bytes;
  state.romSha1 = sha1;
  state.variant = (tool.input.variants ?? []).find((v) => v.sha1 === sha1) ?? null;

  // The info box was already the visible result of checking the extractor; now
  // it becomes the visible result of checking the input too, so both halves of
  // "is this going to work" are answered in the same place.
  const mark = $("io-in-mark");
  $("io-in").textContent = file.name;

  if (state.variant) {
    mark.textContent = "✓";
    mark.className = "mark ok";
    setStatus(status, "ok", `${file.name} — ${state.variant.label}.`);
  } else {
    // An unrecognised ROM is almost always a Lunar Magic hack, which by
    // definition cannot match a known hash. Rather than making the user find
    // and understand a checkbox, accept it and say what we assumed. If it is
    // not a Super Mario World ROM at all, the extraction fails on its own.
    mark.textContent = "!";
    mark.className = "mark warn";
    setStatus(status, "warn",
      `${file.name} — not a stock Super Mario World ROM. Treating it as a ROM hack.`);
  }
  $("go").disabled = false;
}

// --- 3. run ----------------------------------------------------------------

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

  const { wrap, fill } = progressBar();
  status.hidden = false;
  status.className = "status busy";
  status.replaceChildren(document.createTextNode("Starting…"), wrap);

  const worker = new Worker("worker.js", { type: "module" });
  // The ABI has no cancel flag, so this is what a timeout means: stop the
  // thread the module is running on.
  const timer = setTimeout(() => {
    worker.terminate();
    setStatus(status, "bad", "Extraction timed out and was stopped.");
    $("go").disabled = false;
  }, RUN_TIMEOUT_MS);

  worker.onmessage = async (ev) => {
    const m = ev.data;
    if (m.type === "progress") {
      const pct = Math.round((m.stage / m.stages) * 100);
      fill.style.width = `${pct}%`;
      status.firstChild.textContent = `${pct}% — ${m.name} (stage ${m.stage + 1} of ${m.stages})`;
      return;
    }
    clearTimeout(timer);
    worker.terminate();
    $("go").disabled = false;

    if (m.type === "error") {
      setStatus(status, "bad", m.message);
      return;
    }
    await showResults(m, status, warnList, results);
  };

  worker.postMessage({
    wasmBytes: state.wasmBytes,
    input: state.rom,
    flags: state.variant ? 0 : state.tool.flags.noHashCheck,
    expectedOutputs: state.tool.outputs.map((o) => o.filename),
    maxOutputBytes: state.tool.limits?.maxOutputBytes,
  });
}

async function showResults({ outputs, warnings }, status, warnList, results) {
  setStatus(status, "ok", `Done — produced ${outputs.length} file${outputs.length === 1 ? "" : "s"}.`);

  if (warnings.length) {
    warnList.hidden = false;
    for (const w of warnings) {
      const li = document.createElement("li");
      li.textContent = w;                       // module-supplied: text, never markup
      warnList.append(li);
    }
  }

  const reference = state.tool.reference;
  const list = $("downloads");
  for (const out of outputs) {
    const data = new Uint8Array(out.data);
    const sha256 = await digest("SHA-256", data);

    const li = document.createElement("li");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([data], { type: "application/octet-stream" }));
    a.download = out.name;
    a.textContent = `Download ${out.name}`;
    const meta = document.createElement("div");
    meta.className = "meta";

    // If this repo published the hashes of a verified reference run, and the
    // user gave the same input, the output should match exactly. The verdict
    // is the part that means anything to a reader; the hash itself is 64
    // characters of noise until someone actually wants to compare it, so it
    // stays behind a click.
    const expected = reference?.input?.sha1 === state.romSha1
      ? reference.outputs.find((o) => o.name === out.name)
      : null;

    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "hash-toggle";
    if (!expected) {
      toggle.textContent = "Hash";
    } else if (expected.sha256 === sha256) {
      toggle.textContent = "Hash matches \u2713";
      toggle.classList.add("ok");
    } else {
      toggle.textContent = "Hash does not match \u2717";
      toggle.classList.add("bad");
    }

    const hash = document.createElement("code");
    hash.className = "hash-value";
    hash.hidden = true;
    hash.textContent = sha256;
    toggle.addEventListener("click", () => { hash.hidden = !hash.hidden; });

    meta.append(`${data.length.toLocaleString()} bytes \u00b7 `, toggle, hash);

    li.append(a, meta);
    list.append(li);
  }
  results.hidden = false;
}

// --- wiring ----------------------------------------------------------------

$("file").disabled = true;
$("file").addEventListener("change", (e) => acceptFile(e.target.files[0]));
$("go").addEventListener("click", run);

const drop = $("drop");
for (const ev of ["dragenter", "dragover"]) {
  drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("over"); });
}
for (const ev of ["dragleave", "drop"]) {
  drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("over"); });
}
drop.addEventListener("drop", (e) => acceptFile(e.dataTransfer.files[0]));

loadModule();
