// The page must survive a stale published module.
//
// This is not hypothetical. The page ships from main; the dist/ tree it reads
// its manifest from only gains a version on a tag. So between an ABI change and
// the next release, the published module is genuinely older than the page, and
// the verifier correctly refuses it. Without a fallback the whole page dies,
// and it died this way twice: once in a browser and once in CI.
//
// Run against a built site/. Plants a stale "published" source describing a
// module that predates the current export set, then asserts the page still
// comes up on the copy deployed beside it.
//
//   node test-page-stale.mjs [url]

import { chromium } from "playwright";
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";

const url = process.argv[2] ?? "http://localhost:8731/index.html";
const SITE = "site";

if (!existsSync(`${SITE}/manifest.json`)) {
  console.error("build the site first: ./build-page.sh");
  process.exit(2);
}

// Keep the real config so this test leaves the site as it found it.
const realConfig = readFileSync(`${SITE}/config.json`);

const manifest = JSON.parse(readFileSync(`${SITE}/manifest.json`, "utf8"));
const current = readFileSync(`${SITE}/${manifest.tools[0].binary.file}`);

// An "old" module: the current one with the newest exports renamed away, which
// is exactly what an older release looks like to the verifier.
const stale = Buffer.from(
  current.toString("latin1").replaceAll("input_clear", "inputXclear").replaceAll("input_add", "inputXadd"),
  "latin1",
);
mkdirSync(`${SITE}/stale`, { recursive: true });
writeFileSync(`${SITE}/stale/${manifest.tools[0].binary.file}`, stale);
manifest.tools[0].binary.sha256 = createHash("sha256").update(stale).digest("hex");
manifest.tools[0].binary.bytes = stale.length;
writeFileSync(`${SITE}/stale/manifest.json`, JSON.stringify(manifest, null, 2));
// manifestUrl names one manifest directly, which is what the published route
// resolves to; pointing it at the stale copy is the published module going bad.
writeFileSync(`${SITE}/config.json`, JSON.stringify({ manifestUrl: "stale/manifest.json" }, null, 2));

let failures = 0;
const check = (name, cond, detail = "") => {
  if (cond) console.log(`  ok   ${name}`);
  else { console.log(`  FAIL ${name} ${detail}`); failures++; }
};

const browser = await chromium.launch({ args: ["--no-sandbox"] });
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));

try {
  await page.goto(url, { waitUntil: "networkidle" });
  await page.waitForSelector("#about:not([hidden])", { timeout: 15000 });
  check("page recovers from a stale published module", true);
  check("no fatal error is shown", await page.isHidden("#fatal"));
  check("the file picker is usable", (await page.locator("#roles input[type=file]").count()) > 0);
  check("no uncaught errors", errors.length === 0, `-> ${JSON.stringify(errors)}`);
} catch (e) {
  check("page recovers from a stale published module", false, `-> ${e.message}`);
} finally {
  await browser.close();
  writeFileSync(`${SITE}/config.json`, realConfig);
}

console.log(failures === 0
  ? "\nStale-module fallback works."
  : `\n${failures} fallback test(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
