// SPDX-License-Identifier: GPL-3.0-only
/**
 * The Le Space look on funkpost's pages: a control pill with the mark and the
 * page QR, and a credit line for the footer.
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
  },
  de: {
    home: "Le Space",
    qr: "Diese Seite als QR-Code",
    dialog: "QR-Code dieser Seite",
    hint: "Mit dem Telefon scannen — öffnet genau diese Seite.",
    madeWith: "Gebaut mit",
    heart: "das Le-Space-Zeichen, sein erster Knoten als Herz",
    up: "Hoch zu allen funkpost-Seiten",
  },
};

/** The page's own language unless told otherwise; English for anything else. */
const wordsFor = (lang) =>
  WORDS[(lang || document.documentElement.lang || "en").slice(0, 2).toLowerCase()] ?? WORDS.en;

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

const UP_GLYPH =
  `<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" ` +
  `stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">` +
  `<path d="M12 19V5M5.5 11.5 12 5l6.5 6.5"/></svg>`;

/**
 * The credit line's inner HTML, for a footer that renders its own markup (in
 * Svelte: `<p class="ls-credit">{@html creditHTML("en")}</p>`). Built only from
 * the constants above, so it is safe to render as HTML.
 */
export function creditHTML(lang) {
  const words = wordsFor(lang);
  return `<span>${words.madeWith}</span> <a href="${HOME}" rel="noopener">${mark(HEART_NODE, words.heart)}<span>Le Space</span></a>`;
}

/**
 * Append the credit line to a footer — `into` as an element or a selector, the
 * page's first <footer> by default, a new one at the end of <body> if it has none.
 */
export function mountCredit({ lang, into } = {}) {
  const host = typeof into === "string" ? document.querySelector(into) : (into ?? document.querySelector("footer"));
  const line = document.createElement("p");
  line.className = "ls-credit";
  line.innerHTML = creditHTML(lang);
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

/**
 * The control pill, top right: the mark, linked home, and the page QR — a
 * phone scans its way to exactly the page under test. Mounted on <body>, outside
 * any framework's root, and only once.
 *
 * `up`, a URL, puts an arrow first that leads there — on every page but the
 * top one, `FUNKPOST_HOME`.
 */
export function mountPill({ lang, up } = {}) {
  if (document.querySelector(".ls-pill")) return;
  const words = wordsFor(lang);

  const pill = document.createElement("div");
  pill.className = "ls-pill";
  pill.setAttribute("role", "group");
  pill.setAttribute("aria-label", "Le Space");
  pill.innerHTML =
    `<a class="ls-home" href="${HOME}" rel="noopener" title="${words.home}">${mark(ROUND_NODE, words.home)}</a>` +
    `<span class="ls-sep" aria-hidden="true"></span>` +
    `<button type="button" class="ls-qr-btn" aria-expanded="false" aria-label="${words.qr}" title="${words.qr}">${QR_GLYPH}</button>`;
  if (up) {
    const arrow = document.createElement("a");
    arrow.className = "ls-up";
    arrow.href = up;
    arrow.title = words.up;
    arrow.setAttribute("aria-label", words.up);
    arrow.innerHTML = UP_GLYPH;
    const sep = document.createElement("span");
    sep.className = "ls-sep";
    sep.setAttribute("aria-hidden", "true");
    pill.prepend(arrow, sep);
  }
  document.body.append(pill);

  const button = pill.querySelector(".ls-qr-btn");
  let pop = null;

  const close = () => {
    pop?.remove();
    pop = null;
    button.setAttribute("aria-expanded", "false");
    button.classList.remove("open");
  };

  const open = () => {
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
export function mountBrand({ lang, footer, up } = {}) {
  mountPill({ lang, up });
  mountCredit({ lang, into: footer });
}
