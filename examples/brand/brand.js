// SPDX-License-Identifier: GPL-3.0-only
/**
 * The Le Space look on funkpost's pages: a control pill with the mark, the
 * language flags, the theme switch and the page QR, and a credit line for the
 * footer.
 *
 * The rules are Le Space's, and live in Le-Space/landing: the brand package
 * (docs/le-space-brand/README.md) and the page-QR convention (AGENTS.md). This
 * is funkpost's reading of them, for pages not built from that repository.
 *
 * Nothing here makes a request. The QR is drawn on the page with uqr, and the
 * colours come from brand.css, which a page loads beside this.
 *
 * The mark and the name "Le Space" belong to Le Space UG. The GPL covers this
 * code, not the right to use them elsewhere.
 */
import { renderSVG } from "uqr";

const HOME = "https://le-space.de/";

/** The menu of all funkpost pages — where the pill's "up" arrow leads. */
export const FUNKPOST_HOME = "https://nikrause.github.io/funkpost/";

const WORDS = {
  en: {
    home: "Le Space",
    qr: "This page as a QR code",
    dialog: "QR code of this page",
    hint: "Scan with your phone — opens exactly this page.",
    madeWith: "Made with",
    heart: "the Le Space mark, its first node drawn as a heart",
    up: "Up to all funkpost pages",
    languages: "Language",
    toDark: "Switch to dark mode",
    toLight: "Switch to light mode",
  },
  de: {
    home: "Le Space",
    qr: "Diese Seite als QR-Code",
    dialog: "QR-Code dieser Seite",
    hint: "Mit dem Telefon scannen — öffnet genau diese Seite.",
    madeWith: "Gebaut mit",
    heart: "das Le-Space-Zeichen, sein erster Knoten als Herz",
    up: "Hoch zu allen funkpost-Seiten",
    languages: "Sprache",
    toDark: "Zum dunklen Modus wechseln",
    toLight: "Zum hellen Modus wechseln",
  },
};

/** The languages every funkpost page speaks, each named in itself. */
export const LANGS = ["de", "en"];
const LANG_NAMES = { de: "Deutsch", en: "English" };
const THEMES = ["dark", "light"];
// The keys le-space.de uses: one reader, one choice, wherever the pages live.
const LANG_KEY = "ls-locale";
const THEME_KEY = "ls-theme";

const read = (key) => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null; // storage refused: the choice lasts as long as the page
  }
};
const write = (key, value) => {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode */
  }
};

/**
 * A value whose readers hear when it changes. Svelte's store contract
 * (`subscribe` calls back at once and returns the unsubscribe), so a Svelte
 * page reads it as `$lang` — and nothing here depends on Svelte.
 */
function store(initial) {
  let value = initial;
  const readers = new Set();
  return {
    get: () => value,
    subscribe(reader) {
      readers.add(reader);
      reader(value);
      return () => readers.delete(reader);
    },
    set(next) {
      if (next === value) return;
      value = next;
      for (const reader of readers) reader(next);
    },
  };
}

/** German for a German browser, English for everyone else — le-space.de's rule. */
function browserLang() {
  const asked = navigator.languages?.length ? navigator.languages : [navigator.language];
  for (const tag of asked) {
    if (typeof tag !== "string") continue;
    if (/^de\b/i.test(tag)) return "de";
    if (/^en\b/i.test(tag)) return "en";
  }
  return "en";
}

/**
 * The address first — a link or a QR code carries its language — then the
 * reader's last choice, then the browser's.
 */
function startingLang() {
  const asked = new URLSearchParams(location.search).get("lang");
  if (LANGS.includes(asked)) {
    write(LANG_KEY, asked);
    return asked;
  }
  const saved = read(LANG_KEY);
  return LANGS.includes(saved) ? saved : browserLang();
}

/** The page's language, `"de"` or `"en"`. `<html lang>` follows it. */
export const lang = store(startingLang());
document.documentElement.lang = lang.get();

/**
 * Switch the language in place. The address bar says it too (`?lang=`), so the
 * page QR and a copied link open in the same language; the hash stays.
 */
export function setLang(code) {
  if (!LANGS.includes(code)) return;
  write(LANG_KEY, code);
  const url = new URL(location.href);
  url.searchParams.set("lang", code);
  history.replaceState(history.state, "", url);
  document.documentElement.lang = code;
  lang.set(code);
}

const lightQuery = matchMedia("(prefers-color-scheme: light)");
const chosenTheme = () => {
  const stamped = document.documentElement.dataset.theme;
  return THEMES.includes(stamped) ? stamped : null;
};

/**
 * What the page shows, `"dark"` or `"light"`: the reader's choice once there is
 * one, the system's until then — and the system's live, so a phone that turns
 * dark at dusk takes an unchosen page with it.
 */
export const theme = store(chosenTheme() ?? (lightQuery.matches ? "light" : "dark"));
lightQuery.addEventListener("change", () => {
  if (!chosenTheme()) theme.set(lightQuery.matches ? "light" : "dark");
});

/** A choice, kept: `data-theme` on `<html>`, and in storage for the next page. */
export function setTheme(value) {
  if (!THEMES.includes(value)) return;
  document.documentElement.dataset.theme = value;
  write(THEME_KEY, value);
  theme.set(value);
}

export const toggleTheme = () => setTheme(theme.get() === "light" ? "dark" : "light");

const wordsFor = (code) => WORDS[code] ?? WORDS.en;

/**
 * The mark ("Der erste Knoten"), one geometry for both variants: brand.css
 * colours it per theme with the exact values of le-space-mark-*-{dark,light}.svg.
 * Only the local node changes between the mark and its credit variant.
 */
const mark = (node, label) =>
  `<svg class="ls-mark" viewBox="0 0 96 96" role="img" aria-label="${label}">` +
  `<line class="c" x1="42.7" y1="49.96" x2="58.56" y2="34.94" stroke-width="4" stroke-linecap="round"/>` +
  `<line class="c" x1="47.43" y1="63.58" x2="62.8" y2="64.98" stroke-width="4" stroke-linecap="round" stroke-dasharray="0.1 8"/>` +
  `<line class="c" x1="69.85" y1="38.36" x2="72.41" y2="55.37" stroke-width="2.5" stroke-linecap="round" stroke-dasharray="0.1 6" opacity="0.65"/>` +
  node +
  `<circle class="c" cx="68" cy="26" r="8" fill="none" stroke-width="5"/>` +
  `<circle class="c" cx="74" cy="66" r="6.5" fill="none" stroke-width="4.5"/>` +
  `<circle class="cf" cx="17" cy="21" r="2.6" opacity="0.55"/>` +
  `</svg>`;

/** The mark as it stands in a header: the local node round. */
const ROUND_NODE = `<circle class="k" cx="30" cy="62" r="15"/>`;
/** The credit variant, for signature lines only: the local node as a heart. */
const HEART_NODE =
  `<path class="k" d="M 0.5 0.96 C 0.19 0.74 0 0.55 0 0.36 A 0.25 0.25 0 0 1 0.5 0.26 ` +
  `A 0.25 0.25 0 0 1 1 0.36 C 1 0.55 0.81 0.74 0.5 0.96 Z" transform="translate(15,47) scale(30)"/>`;

const QR_GLYPH =
  `<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="currentColor" fill-rule="evenodd">` +
  `<path d="M3 3h7v7H3zM5 5h3v3H5zM14 3h7v7h-7zM16 5h3v3h-3zM3 14h7v7H3zM5 16h3v3H5z` +
  `M14 14h2v2h-2zM18 14h3v2h-3zM14 18h3v3h-3zM19 18h2v3h-2z"/></svg>`;

/** The flags le-space.de draws: SVG, so every system shows the same thing. */
const FLAG = {
  de:
    `<svg viewBox="0 0 5 3" aria-hidden="true">` +
    `<rect width="5" height="1" y="0" fill="#000000"/><rect width="5" height="1" y="1" fill="#DD0000"/>` +
    `<rect width="5" height="1" y="2" fill="#FFCE00"/></svg>`,
  en:
    `<svg viewBox="0 0 60 30" aria-hidden="true">` +
    `<clipPath id="ls-uk-clip"><path d="M0,0 v30 h60 v-30 z"/></clipPath>` +
    `<clipPath id="ls-uk-tri"><path d="M30,15 h30 v15 z v15 h-30 z h-30 v-15 z v-15 h30 z"/></clipPath>` +
    `<g clip-path="url(#ls-uk-clip)"><path d="M0,0 v30 h60 v-30 z" fill="#012169"/>` +
    `<path d="M0,0 L60,30 M60,0 L0,30" stroke="#ffffff" stroke-width="6"/>` +
    `<path d="M0,0 L60,30 M60,0 L0,30" clip-path="url(#ls-uk-tri)" stroke="#C8102E" stroke-width="4"/>` +
    `<path d="M30,0 v30 M0,15 h60" stroke="#ffffff" stroke-width="10"/>` +
    `<path d="M30,0 v30 M0,15 h60" stroke="#C8102E" stroke-width="6"/></g></svg>`,
};

/** The theme button shows what a press gives: the moon on a light page, the sun on a dark one. */
const MOON_GLYPH =
  `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z" ` +
  `fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>`;
const SUN_GLYPH =
  `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4.2" fill="none" stroke="currentColor" stroke-width="1.8"/>` +
  `<g stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2"/>` +
  `<path d="M5.2 5.2l1.6 1.6M17.2 17.2l1.6 1.6M18.8 5.2l-1.6 1.6M6.8 17.2l-1.6 1.6"/></g></svg>`;

const UP_GLYPH =
  `<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" ` +
  `stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">` +
  `<path d="M12 19V5M5.5 11.5 12 5l6.5 6.5"/></svg>`;

/**
 * The credit line's inner HTML, for a footer that renders its own markup (in
 * Svelte: `<p class="ls-credit">{@html creditHTML($lang)}</p>`). Built only from
 * the constants above, so it is safe to render as HTML.
 */
export function creditHTML(code = lang.get()) {
  const words = wordsFor(code);
  return `<span>${words.madeWith}</span> <a href="${HOME}" rel="noopener">${mark(HEART_NODE, words.heart)}<span>Le Space</span></a>`;
}

/**
 * Append the credit line to a footer — `into` as an element or a selector, the
 * page's first <footer> by default, a new one at the end of <body> if it has none.
 * It follows the page's language.
 */
export function mountCredit({ into } = {}) {
  const host = typeof into === "string" ? document.querySelector(into) : (into ?? document.querySelector("footer"));
  const line = document.createElement("p");
  line.className = "ls-credit";
  lang.subscribe((code) => (line.innerHTML = creditHTML(code)));
  if (host) {
    host.append(line);
  } else {
    const footer = document.createElement("footer");
    footer.className = "ls-footer";
    footer.append(line);
    document.body.append(footer);
  }
  return line;
}

/** This page, in another language: the same address with `?lang=` set, hash and all. */
const addressIn = (code) => {
  const url = new URL(location.href);
  url.searchParams.set("lang", code);
  return url.href;
};

/**
 * The control pill, top right, as on le-space.de: the mark, linked home; the
 * two flags; the theme switch; and the page QR — a phone scans its way to
 * exactly the page under test, in the same language. Mounted on <body>,
 * outside any framework's root, and only once.
 *
 * `up`, a URL, puts an arrow first that leads there — on every page but the
 * top one, `FUNKPOST_HOME`.
 */
export function mountPill({ up } = {}) {
  if (document.querySelector(".ls-pill")) return;

  const pill = document.createElement("div");
  pill.className = "ls-pill";
  pill.setAttribute("role", "group");
  pill.setAttribute("aria-label", "Le Space");
  const sep = `<span class="ls-sep" aria-hidden="true"></span>`;
  pill.innerHTML =
    (up ? `<a class="ls-up">${UP_GLYPH}</a>${sep}` : "") +
    `<a class="ls-home" href="${HOME}" rel="noopener" title="Le Space">${mark(ROUND_NODE, "Le Space")}</a>` +
    sep +
    LANGS.map(
      (code) =>
        `<a class="ls-flag" hreflang="${code}" data-choice="${code}" title="${LANG_NAMES[code]}" ` +
        `aria-label="${LANG_NAMES[code]}">${FLAG[code]}</a>`,
    ).join("") +
    sep +
    `<button type="button" class="ls-theme"></button>` +
    `<button type="button" class="ls-qr-btn" aria-expanded="false">${QR_GLYPH}</button>`;
  if (up) pill.querySelector(".ls-up").href = up;
  document.body.append(pill);

  const flags = [...pill.querySelectorAll(".ls-flag")];
  const themeButton = pill.querySelector(".ls-theme");
  const button = pill.querySelector(".ls-qr-btn");

  // Real links, so a new tab or "copy link" gets the page in that language; a
  // plain click switches in place, and whatever the page holds stays.
  for (const flag of flags) {
    const refresh = () => (flag.href = addressIn(flag.dataset.choice));
    refresh();
    for (const event of ["pointerenter", "pointerdown", "focus"]) flag.addEventListener(event, refresh);
    flag.addEventListener("click", (event) => {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
      event.preventDefault();
      setLang(flag.dataset.choice);
    });
  }
  themeButton.addEventListener("click", toggleTheme);

  const label = () => {
    const words = wordsFor(lang.get());
    const up = pill.querySelector(".ls-up");
    if (up) {
      up.title = words.up;
      up.setAttribute("aria-label", words.up);
    }
    for (const flag of flags) {
      const current = flag.dataset.choice === lang.get();
      flag.classList.toggle("active", current);
      if (current) flag.setAttribute("aria-current", "true");
      else flag.removeAttribute("aria-current");
    }
    const light = theme.get() === "light";
    themeButton.innerHTML = light ? MOON_GLYPH : SUN_GLYPH;
    themeButton.title = light ? words.toDark : words.toLight;
    themeButton.setAttribute("aria-label", themeButton.title);
    themeButton.setAttribute("aria-pressed", String(light));
    button.title = words.qr;
    button.setAttribute("aria-label", words.qr);
  };
  lang.subscribe(label);
  theme.subscribe(label);

  let pop = null;

  const close = () => {
    pop?.remove();
    pop = null;
    button.setAttribute("aria-expanded", "false");
    button.classList.remove("open");
  };

  const open = () => {
    const words = wordsFor(lang.get());
    // Whatever the address bar says at this moment, hash and query included,
    // so the phone lands on the same page in the same state.
    const url = location.href;
    pop = document.createElement("div");
    pop.className = "ls-qr-pop";
    pop.setAttribute("role", "dialog");
    pop.setAttribute("aria-label", words.dialog);
    const plaque = document.createElement("div");
    plaque.className = "ls-qr-plaque";
    plaque.innerHTML = renderSVG(url, { border: 2 });
    const address = document.createElement("p");
    address.className = "ls-qr-url";
    address.textContent = url;
    const hint = document.createElement("p");
    hint.className = "ls-qr-hint";
    hint.textContent = words.hint;
    pop.append(plaque, address, hint);
    document.body.append(pop);
    button.setAttribute("aria-expanded", "true");
    button.classList.add("open");
  };

  button.addEventListener("click", () => (pop ? close() : open()));
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && pop) {
      close();
      button.focus();
    }
  });
  document.addEventListener("pointerdown", (event) => {
    if (pop && !pop.contains(event.target) && !pill.contains(event.target)) close();
  });
}

/** Both at once, for a page whose markup is plain HTML. */
export function mountBrand({ footer, up } = {}) {
  mountPill({ up });
  mountCredit({ into: footer });
}
