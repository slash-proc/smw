// End-to-end test of the published page, driven in a real browser.
//
// The page is the reference consumer of this spec, so the things that break it
// are browser-only: a module that will not parse, a listener that never fires,
// a Worker that cannot start. None of that is visible to node, which is why
// this exists separately from test.mjs.
//
//   node test-page.mjs <rom> [url]

import { chromium } from "playwright";

// Without a ROM this runs the load-and-verify half only. That half is what
// catches the failures this page has actually had -- a module that will not
// parse in a browser takes the whole page down before any ROM is involved --
// and it needs no copyrighted input, so it can run on a public CI runner.
const rom = process.argv[2] || null;
const url = process.argv[3] ?? "http://localhost:8731/index.html";

let failures = 0;
const check = (name, cond, detail = "") => {
  if (cond) console.log(`  ok   ${name}`);
  else { console.log(`  FAIL ${name} ${detail}`); failures++; }
};

const browser = await chromium.launch({ args: ["--no-sandbox"] });
const page = await browser.newPage();

// Anything the page logs as an error is a failure, even if the flow survives:
// a page that works by accident is one refactor from not working.
const problems = [];
page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
// A cross-origin 404 is expected and is not a page bug: the page asks the dist
// branch for a published manifest first, and that branch does not exist until
// the project has been tagged. The browser logs the failed request as a console
// error regardless, and the page then falls back to the module deployed beside
// it -- which is the behaviour test-page-stale.mjs covers. Same-origin failures
// stay fatal, because those are files this build should have produced.
const pageOrigin = new URL(url).origin;
page.on("console", (m) => {
  if (m.type() !== "error") return;
  const from = m.location()?.url ?? "";
  const expected = /Failed to load resource/.test(m.text())
    && from && !from.startsWith(pageOrigin);
  if (!expected) problems.push(`console: ${m.text()}`);
});

await page.goto(url, { waitUntil: "networkidle" });

// --- the module loads and verifies ----------------------------------------
await page.waitForSelector("#about:not([hidden])", { timeout: 15000 });
check("info box appears (module fetched, hash-matched and verified)", true);
check("no fatal error shown", await page.isHidden("#fatal"));
check("declares its input", (await page.textContent("#io-in")).includes("ROM"));
check("declares its output", (await page.textContent("#io-out")).includes(".dat"));

// --- the language switch ---------------------------------------------------
// The page ships three locales. Switching must redraw the whole interface, not
// half of it, and must survive a reload.
// Compare a string the page owns, not one that comes from the manifest: a
// proper noun like "Super Mario World ROM" is legitimately the same in every
// language, so it proves nothing either way.
const enRun = await page.textContent("#go");
const enWhy = await page.textContent("#why-text");
await page.selectOption("#lang", "de");
const deRun = await page.textContent("#go");
check("switching to German changes the interface", deRun !== enRun, `-> ${deRun}`);
check("German reaches the buttons too", /umwandeln/i.test(deRun), `-> ${deRun}`);
check("German reaches the explanatory text too",
  (await page.textContent("#why-text")) !== enWhy);
check("html lang attribute follows the choice",
  (await page.getAttribute("html", "lang")) === "de");

await page.selectOption("#lang", "fr");
const frRun = await page.textContent("#go");
check("French reaches the buttons too", /convertir/i.test(frRun), `-> ${frRun}`);

await page.reload({ waitUntil: "networkidle" });
await page.waitForSelector("#about:not([hidden])", { timeout: 15000 });
check("the chosen language is remembered across a reload",
  (await page.inputValue("#lang")) === "fr");

await page.selectOption("#lang", "en");
check("switching back restores English", (await page.textContent("#go")) === enRun);

// The "?" must actually do something: it was a dead tooltip once.
check("the explanation starts hidden", await page.isHidden("#why-text"));
await page.click("#why");
check("clicking ? reveals the explanation", await page.isVisible("#why-text"));
await page.click("#why");
check("clicking ? again hides it", await page.isHidden("#why-text"));

if (!rom) {
  check("page logged no errors", problems.length === 0, `-> ${JSON.stringify(problems, null, 2)}`);
  await page.screenshot({ path: process.env.PAGE_SHOT ?? "page.png", fullPage: true });
  await browser.close();
  console.log(failures === 0
    ? "\nLoad tests passed (no ROM given; extraction not exercised)."
    : `\n${failures} test(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

// --- picking a ROM gives feedback -----------------------------------------
await page.setInputFiles("#roles input[type=file]", rom);
await page.waitForSelector("#roles .status:not([hidden])", { timeout: 15000 });
const fileStatus = await page.textContent("#roles .status");
check("selecting a ROM reports what it is", /Super Mario World/i.test(fileStatus), `-> ${fileStatus}`);
check("recognised ROM is not flagged as modified", !/modified/i.test(fileStatus), `-> ${fileStatus}`);
// Hashing the file is asynchronous, so the button is enabled a tick after the
// status text appears. Wait for it rather than sampling at whichever moment
// the previous assertion happened to finish.
const enabled = await page.waitForSelector("#go:not([disabled])", { timeout: 15000 })
  .then(() => true).catch(() => false);
check("extract button is enabled", enabled);

// --- extraction, with progress --------------------------------------------
const stages = new Set();
await page.exposeFunction("__stage", (s) => stages.add(s));
await page.evaluate(() => {
  const el = document.getElementById("run-status");
  new MutationObserver(() => window.__stage(el.textContent)).observe(
    el, { childList: true, characterData: true, subtree: true });
});

await page.click("#go");
await page.waitForSelector("#downloads a", { timeout: 120000 });

const seen = [...stages].filter((s) => /step \d+ of/i.test(s));
check("progress reported named stages", seen.length > 1, `-> saw ${seen.length}`);
check("stage names are shown", seen.some((s) => /graphics|audio|sprites/i.test(s)),
  `-> ${JSON.stringify(seen.slice(0, 3))}`);

const meta = await page.textContent("#downloads .meta");
check("output matches the published reference hash", /hash matches/i.test(meta), `-> ${meta}`);
check("the hash itself is hidden until asked for", await page.isHidden("#downloads .hash-value"));
await page.click("#downloads .hash-toggle");
check("clicking reveals the hash",
  /^[0-9a-f]{64}$/.test((await page.textContent("#downloads .hash-value")).trim()));
check("download link is offered", (await page.getAttribute("#downloads a", "download")) === "smw_assets.dat");
check("no Game & Watch references on the page",
  !/game\s*&\s*watch|game and watch/i.test(await page.textContent("body")));

check("page logged no errors", problems.length === 0, `-> ${JSON.stringify(problems, null, 2)}`);

await page.screenshot({ path: process.env.PAGE_SHOT ?? "page.png", fullPage: true });
await browser.close();

console.log(failures === 0 ? "\nAll page tests passed." : `\n${failures} page test(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
