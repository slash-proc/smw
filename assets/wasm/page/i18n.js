// Page translations and the locale store.
//
// Dependency-free by necessity: this page ships as static files to GitHub
// Pages and the whole point of the project is that what runs is settled at
// build time, so pulling an i18n library from a CDN at load time would be
// working against it. The shape deliberately mirrors gnw-web-builder's own
// i18n so the two read the same way: strings nested by section rather than
// flat dotted keys, English as the base that every other locale is checked
// against, values that need arguments written as functions returning template
// literals, and the language remembered in localStorage under "locale".
//
// Two different languages meet on this page and must not be confused. This
// module handles the *page* language -- the words in the interface. Which
// language the converted game data ends up in is decided by which ROM the user
// supplies, and is described by the manifest. Someone may well want a German
// interface while building a French asset pack.
//
// House style for the copy below, learned from review:
//   - "convert", not "extract". Users are converting a file they own into one
//     the port can read; "extraction" is our word, not theirs.
//   - no em dashes anywhere. Break the sentence or use a comma.
//   - translations are written the way someone would actually speak. German in
//     particular should not chain every proper noun into one compound.

export const SUPPORTED = [
  { code: "en", label: "English" },
  { code: "fr", label: "Français" },
  { code: "de", label: "Deutsch" },
];

// English is the base. Every other locale below is a translation of exactly
// these keys; a missing key falls back to the English one rather than showing
// a blank or a key name to the user.
const en = {
  app: {
    heading: (title) => `${title} asset converter`,
    lede: (input, output) => `Convert ${input} into ${output}`,
  },
  lang: {
    label: "Language",
    aria: "Choose the language of this page",
  },
  io: {
    input: "Input",
    output: "Output",
  },
  why: {
    label: "What this does",
    text: "The necessary assets are extracted and exported to smw_assets.dat in the browser, never leaving your computer.",
  },
  input: {
    heading: "Your files",
    choose: "Choose a file, or drop one here",
    optional: "optional",
    reading: (name) => `Reading ${name}…`,
    tooLarge: (name) => `${name} is too big to be the right file.`,
    recognised: (name, variant) => `${name}: ${variant}.`,
    unrecognised: (name, role) =>
      `${name} is not a stock ${role}. Treating it as a modified copy.`,
    missingRequired: "Choose the required file to continue.",
  },
  run: {
    heading: "Convert",
    button: "Convert",
    starting: "Starting…",
    progress: (pct, name, stage, stages) =>
      `${pct}% · ${name} (step ${stage} of ${stages})`,
    timedOut: "This took too long and was stopped.",
    done: (n) => `Done, ${n} file${n === 1 ? "" : "s"} ready.`,
  },
  results: {
    heading: "Output",
    download: (name) => `Download ${name}`,
    bytes: (n) => `${n.toLocaleString("en-GB")} bytes`,
    hash: "Hash",
    hashMatches: "Hash matches ✓",
    hashDiffers: "Hash does not match ✗",
  },
  footer: {
    source: "Source and documentation:",
    repo: "the project repository",
    published:
      "This page comes from the same CI run that builds and checks the converter, so the two always match.",
  },
  fatal: {
    cannotRun: (msg) => `This page cannot run: ${msg}`,
    noManifest: "the converter manifest could not be loaded",
    mismatch: "the converter does not match its manifest",
    unsafe: (errs) => `the converter failed its safety checks: ${errs}`,
  },
};

const fr = {
  app: {
    heading: (title) => `Convertisseur de ressources ${title}`,
    lede: (input, output) => `Convertir ${input} en ${output}`,
  },
  lang: {
    label: "Langue",
    aria: "Choisir la langue de cette page",
  },
  io: {
    input: "Entrée",
    output: "Sortie",
  },
  why: {
    label: "Ce que fait cette page",
    text: "Les ressources nécessaires sont extraites et enregistrées dans smw_assets.dat directement dans le navigateur. Rien ne quitte votre ordinateur.",
  },
  input: {
    heading: "Vos fichiers",
    choose: "Choisissez un fichier, ou déposez-le ici",
    optional: "facultatif",
    reading: (name) => `Lecture de ${name}…`,
    tooLarge: (name) => `${name} est trop volumineux pour être le bon fichier.`,
    recognised: (name, variant) => `${name} : ${variant}.`,
    unrecognised: (name, role) =>
      `${name} n'est pas un ${role} d'origine. Il sera traité comme une copie modifiée.`,
    missingRequired: "Choisissez le fichier requis pour continuer.",
  },
  run: {
    heading: "Convertir",
    button: "Convertir",
    starting: "Démarrage…",
    progress: (pct, name, stage, stages) =>
      `${pct} % · ${name} (étape ${stage} sur ${stages})`,
    timedOut: "L'opération a pris trop de temps et a été interrompue.",
    done: (n) => `Terminé, ${n} fichier${n === 1 ? "" : "s"} prêt${n === 1 ? "" : "s"}.`,
  },
  results: {
    heading: "Sortie",
    download: (name) => `Télécharger ${name}`,
    bytes: (n) => `${n.toLocaleString("fr-FR")} octets`,
    hash: "Empreinte",
    hashMatches: "Empreinte conforme ✓",
    hashDiffers: "Empreinte non conforme ✗",
  },
  footer: {
    source: "Code source et documentation :",
    repo: "le dépôt du projet",
    published:
      "Cette page provient de la même exécution CI qui compile et vérifie le convertisseur. Les deux correspondent donc toujours.",
  },
  fatal: {
    cannotRun: (msg) => `Cette page ne peut pas fonctionner : ${msg}`,
    noManifest: "le manifeste du convertisseur n'a pas pu être chargé",
    mismatch: "le convertisseur ne correspond pas à son manifeste",
    unsafe: (errs) => `le convertisseur a échoué aux contrôles de sécurité : ${errs}`,
  },
};

const de = {
  app: {
    heading: (title) => `${title} Asset-Konverter`,
    lede: (input, output) => `${input} in ${output} umwandeln`,
  },
  lang: {
    label: "Sprache",
    aria: "Sprache dieser Seite wählen",
  },
  io: {
    input: "Eingabe",
    output: "Ausgabe",
  },
  why: {
    label: "Was hier passiert",
    text: "Die benötigten Assets werden direkt im Browser ausgelesen und in smw_assets.dat gespeichert. Nichts wird hochgeladen, alles bleibt auf deinem Rechner.",
  },
  input: {
    heading: "Deine Dateien",
    choose: "Datei auswählen oder hierher ziehen",
    optional: "optional",
    reading: (name) => `${name} wird gelesen…`,
    tooLarge: (name) => `${name} ist zu groß für die erwartete Datei.`,
    recognised: (name, variant) => `${name}: ${variant}.`,
    unrecognised: (name, role) =>
      `${name} ist kein unverändertes ${role}. Es wird als bearbeitete Fassung behandelt.`,
    missingRequired: "Wähle die benötigte Datei aus, um weiterzumachen.",
  },
  run: {
    heading: "Umwandeln",
    button: "Umwandeln",
    starting: "Es geht los…",
    progress: (pct, name, stage, stages) =>
      `${pct} % · ${name} (Schritt ${stage} von ${stages})`,
    timedOut: "Das hat zu lange gedauert und wurde abgebrochen.",
    done: (n) => `Fertig, ${n} Datei${n === 1 ? "" : "en"} bereit.`,
  },
  results: {
    heading: "Ausgabe",
    download: (name) => `${name} herunterladen`,
    bytes: (n) => `${n.toLocaleString("de-DE")} Bytes`,
    hash: "Prüfsumme",
    hashMatches: "Prüfsumme stimmt ✓",
    hashDiffers: "Prüfsumme stimmt nicht ✗",
  },
  footer: {
    source: "Quellcode und Dokumentation:",
    repo: "das Projekt-Repository",
    published:
      "Diese Seite stammt aus demselben CI-Lauf, der den Konverter baut und prüft. Beides passt also immer zusammen.",
  },
  fatal: {
    cannotRun: (msg) => `Diese Seite funktioniert nicht: ${msg}`,
    noManifest: "das Manifest des Konverters konnte nicht geladen werden",
    mismatch: "der Konverter passt nicht zu seinem Manifest",
    unsafe: (errs) => `der Konverter hat die Sicherheitsprüfungen nicht bestanden: ${errs}`,
  },
};

const STRINGS = { en, fr, de };

// Fall back key by key rather than whole-locale, so a partial translation
// degrades to English only where it is actually missing.
function withFallback(locale) {
  const base = STRINGS.en;
  const over = STRINGS[locale] ?? {};
  const out = {};
  for (const section of Object.keys(base)) {
    out[section] = { ...base[section], ...(over[section] ?? {}) };
  }
  return out;
}

// A visitor whose browser is set to a language we speak should get it without
// touching anything. Region is ignored: de-AT and de-DE both get German.
function matchBrowser() {
  for (const tag of navigator.languages ?? [navigator.language ?? "en"]) {
    const want = tag.toLowerCase().split("-")[0];
    if (SUPPORTED.some((l) => l.code === want)) return want;
  }
  return "en";
}

function initial() {
  let stored = null;
  try {
    stored = localStorage.getItem("locale");
  } catch { /* storage blocked: fall back to the browser's language */ }
  // An explicit choice outranks the browser's setting, but only once made.
  return SUPPORTED.some((l) => l.code === stored) ? stored : matchBrowser();
}

let current = initial();
let strings = withFallback(current);
const listeners = new Set();

export const locale = () => current;
export const t = () => strings;

export function setLocale(code) {
  if (!SUPPORTED.some((l) => l.code === code)) return;
  current = code;
  strings = withFallback(code);
  try {
    localStorage.setItem("locale", code);
  } catch { /* not persisting is survivable; the page still switches */ }
  document.documentElement.lang = code;
  for (const fn of listeners) fn();
}

/** Runs `fn` now and again on every language change. */
export function onLocaleChange(fn) {
  listeners.add(fn);
  fn();
}

/**
 * Reads a localised string out of the manifest, which stores them as
 * `{en, fr, de}` objects. Plain strings are passed through so a manifest that
 * has not been localised still renders.
 */
export function localeText(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  return value[current] ?? value.en ?? "";
}

/**
 * Applies translations to any element carrying `data-i18n="section.key"`, plus
 * `data-i18n-title` and `data-i18n-aria-label` for the attribute forms. Keeps
 * the static markup readable and means adding a string to the page is one
 * attribute rather than a line of JS.
 */
export function applyStatic(root = document) {
  const lookup = (path) => {
    const [section, key] = path.split(".");
    const v = strings[section]?.[key];
    return typeof v === "function" ? v() : v;
  };
  for (const el of root.querySelectorAll("[data-i18n]")) {
    const v = lookup(el.dataset.i18n);
    if (v != null) el.textContent = v;
  }
  for (const el of root.querySelectorAll("[data-i18n-title]")) {
    const v = lookup(el.dataset.i18nTitle);
    if (v != null) el.title = v;
  }
  for (const el of root.querySelectorAll("[data-i18n-aria-label]")) {
    const v = lookup(el.dataset.i18nAriaLabel);
    if (v != null) el.setAttribute("aria-label", v);
  }
}
