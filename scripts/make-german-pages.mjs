// SPDX-License-Identifier: GPL-3.0-only
/**
 * The German page, generated from the English one.
 *
 * A social card is read by a **scraper**, not a browser: it does not run the
 * page, has no `localStorage`, sends no useful `Accept-Language`, and caches
 * what it finds per URL. So the language somebody switched on can never reach
 * it — the only way a shared German link previews in German is for German to
 * have an address of its own.
 *
 * Generated rather than written twice, so a correction to the English head
 * cannot silently leave the German one behind. The German file is a build
 * artefact: it is written beside `index.html`, listed as a second Vite input,
 * and git-ignored.
 *
 * Two paths have to be rewritten, and both are easy to get wrong:
 *
 * - **Public-directory references stay relative.** Vite copies `public/`
 *   verbatim and does not rewrite `./favicon-32.png`, so from one level down it
 *   would 404. They become `../`.
 * - **The manifest is the exception.** `start_url: "./"` must mean *this*
 *   page, or installing from the German page installs the English one, so the
 *   German page gets a manifest of its own.
 *
 * Built assets are untouched: with an absolute `base` they are absolute
 * already and work from any depth.
 *
 *   node scripts/make-german-pages.mjs examples/mesh-trail
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";

const SITE = "https://nikrause.github.io/funkpost";

/**
 * What each page says about itself, in German.
 *
 * `at` is where the page lives on the site, which is not always its directory
 * name: the landing page owns the root, so its German twin is `/de/` rather
 * than `/landing/de/`.
 */
export const GERMAN = {
  landing: {
    at: "",
    title: "funkpost — vier Demos über ein LoRa-Mesh",
    description:
      "Ein Byte-Kurier über LoRa®-Mesh-Funkgeräte: eine Todo-Liste, ein Terminbuch, ein Reichweitentest und ein Spaziergang. Nirgends ein IP-Weg.",
    alt: "Zwei cyanfarbene Knotenringe mit Funkbögen dazwischen und einer korallenroten Nutzlast in der Mitte, auf dunklem Grund: funkpost.",
  },
  "mesh-todo": {
    title: "mesh-todo — eine Todo-Liste über LoRa",
    description:
      "Signierte Einträge und ein prüfbares Log, zwischen zwei Browsern über ein LoRa®-Mesh repliziert — nirgends ein IP-Weg.",
    alt: "Ein cyanfarbener Ring mit einem korallenroten Haken auf dunklem Grund: mesh-todo, die Datenbank-Ebene.",
  },
  "mesh-calendar": {
    title: "mesh-calendar — das Terminbuch eines Friseurs",
    description:
      "Regeln statt Listen: drei Wochen freie Zeiten in einem Frame, und eine Buchung, die in 31 Sekunden über ein echtes Mesh lief.",
    alt: "Ein violetter Kalenderumriss mit korallenroter Marke auf dunklem Grund: mesh-calendar, die Ereignis-Ebene.",
  },
  "mesh-heartbeat": {
    title: "mesh-heartbeat — wie weit reicht das Mesh?",
    description:
      "Ein Gerät bleibt stehen und antwortet, das andere fährt und fragt. Zurück kommt ein Ort mit einer Antwort oder einem Schweigen daneben.",
    alt: "Ein cyanfarbenes Fadenkreuz mit korallenrotem Zentrum auf dunklem Grund: mesh-heartbeat.",
  },
  "mesh-trail": {
    title: "mesh-trail — alle auf einer Karte",
    description:
      "Jedes Gerät sagt im Takt, wo es ist; jedes andere hört es und zeichnet die Spur. Kein Internet, keine Datenbank.",
    alt: "Zwei Spuren in Cyan und Violett mit korallenrotem Kopf auf dunklem Grund: mesh-trail.",
  },
};

/** Where a page and its German twin live, as absolute addresses. */
function addresses(app) {
  const at = GERMAN[app].at ?? app;
  const dir = at ? `${SITE}/${at}/` : `${SITE}/`;
  return { english: dir, german: `${dir}de/`, card: `${dir}og-de.png` };
}

/**
 * @param {string} english the built or source index.html
 * @param {string} app which page
 * @returns {string} the German page
 */
export function germanPage(english, app) {
  const words = GERMAN[app];
  if (!words) throw new Error(`no German words for ${app}`);
  const where = addresses(app);
  let s = english;

  s = s.replace(/<html lang="[^"]*"/, '<html lang="de"');

  // Public-directory references are one level further away now.
  s = s.replace(/(href|src)="\.\/(?!assets\/)/g, '$1="../');
  // …except the manifest, which must point at this page's own.
  s = s.replace(/href="\.\.\/manifest\.webmanifest"/, 'href="./manifest.webmanifest"');
  // A link out of the landing page keeps the language it was clicked in.
  s = s.replace(/href="\.\.\/(mesh-[a-z]+)\/"/g, 'href="../$1/de/"');
  // An import is a reference too. The landing page reaches the brand pill from
  // an import map and a module script, neither of which has an href, and both
  // would 404 one level down — silently, since a missing pill looks like a
  // plain page. Hence the assertion below rather than a longer list of rules.
  s = s.replace(/"\.\/brand\//g, '"../brand/');

  const missed = s.match(/["'(]\.\/(?!assets\/|manifest\.webmanifest)[^"']*/g);
  if (missed) throw new Error(`${app}: ${missed.join(", ")} would 404 one level down`);

  const tags = {
    "og:title": words.title,
    "og:description": words.description,
    "og:url": where.german,
    "og:image": where.card,
    "og:image:alt": words.alt,
  };
  for (const [name, value] of Object.entries(tags)) {
    // `\s+`, not a space: prettier wraps a long attribute onto its own line,
    // and the landing page is over the width where it does.
    const pattern = new RegExp(`(<meta\\s+property="${name}"\\s+content=")[^"]*(")`);
    if (!pattern.test(s)) throw new Error(`${app}: no ${name} to translate`);
    s = s.replace(pattern, `$1${value.replace(/"/g, "&quot;")}$2`);
  }
  s = s.replace(/(<meta\s+name="description"\s+content=")[^"]*(")/, `$1${words.description}$2`);
  s = s.replace(/(<title>)[^<]*(<\/title>)/, `$1${words.title}$2`);

  // Which page is which, for a search engine and for the other language. The
  // English page carries its own set and they come across with the copy, so
  // they are stripped rather than added to — two canonicals is worse than none.
  s = s.replace(/^[ \t]*<link rel="(?:canonical|alternate)"[^>]*>\n/gm, "");
  s = s.replace(/^[ \t]*<meta property="og:locale(?::alternate)?"[^>]*>\n/gm, "");

  const links =
    `    <link rel="canonical" href="${where.german}" />\n` +
    `    <link rel="alternate" hreflang="de" href="${where.german}" />\n` +
    `    <link rel="alternate" hreflang="en" href="${where.english}" />\n` +
    `    <link rel="alternate" hreflang="x-default" href="${where.english}" />\n` +
    `    <meta property="og:locale" content="de_DE" />\n` +
    `    <meta property="og:locale:alternate" content="en_GB" />\n`;
  // After the social block, whose last line every page here shares. The
  // manifest is not an anchor: the landing page has none.
  const anchor = /^([ \t]*)<meta name="twitter:card"[^>]*>\n/m;
  if (!anchor.test(s)) throw new Error(`${app}: nowhere to say which page is which`);
  s = s.replace(anchor, (line) => line + links);
  return s;
}

/** The same manifest, named in German and rooted at the German page. */
export function germanManifest(english, app) {
  const m = JSON.parse(english);
  const words = GERMAN[app];
  return JSON.stringify(
    {
      ...m,
      description: words.description,
      // Relative to this file, which now lives one level down.
      icons: m.icons.map((icon) => ({ ...icon, src: icon.src.replace(/^\.\//, "../") })),
    },
    null,
    2,
  ) + "\n";
}

if (process.argv[2]) {
  const app = resolve(process.argv[2]);
  const name = app.split("/").filter(Boolean).at(-1);
  const out = join(app, "de");
  mkdirSync(out, { recursive: true });
  writeFileSync(
    join(out, "index.html"),
    germanPage(readFileSync(join(app, "index.html"), "utf8"), name),
  );
  let also = "";
  // The landing page is copied, not bundled, and has nothing to install.
  const manifest = join(app, "public", "manifest.webmanifest");
  if (existsSync(manifest)) {
    mkdirSync(join(app, "public", "de"), { recursive: true });
    writeFileSync(
      join(app, "public", "de", "manifest.webmanifest"),
      germanManifest(readFileSync(manifest, "utf8"), name),
    );
    also = " and its manifest";
  }
  console.log(`${name}/de/index.html${also}`);
}
