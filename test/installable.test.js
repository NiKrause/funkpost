// SPDX-License-Identifier: GPL-3.0-only
/**
 * Whether a browser will offer to install these demos.
 *
 * All three are meant to go on a phone's home screen: a field test happens
 * where there is no desk, and a demo the operator has to find in a browser's
 * history at the kerb is a demo that does not get run. Installability is not a
 * matter of taste — Chrome checks a specific list, refuses silently when any
 * of it is missing, and says nothing an operator would see.
 *
 * The expensive failure is an icon the manifest names and the build does not
 * ship: the page loads, everything works, and the install prompt simply never
 * appears. Nothing else here would notice, which is why the sizes are read out
 * of the PNGs rather than trusted.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { GERMAN, germanPage, germanManifest } from "../scripts/make-german-pages.mjs";

const at = (rel) => fileURLToPath(new URL(rel, import.meta.url));

/** Width and height out of a PNG's IHDR, which is always the first chunk. */
function pngSize(path) {
  const bytes = readFileSync(path);
  assert.equal(bytes.subarray(1, 4).toString("ascii"), "PNG", `${path} is not a PNG`);
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

const APPS = ["mesh-todo", "mesh-calendar", "mesh-heartbeat", "mesh-trail"];

describe("the demos can be installed", () => {
  for (const app of APPS) {
    describe(app, () => {
      const dir = at(`../examples/${app}/public/`);
      const manifest = JSON.parse(readFileSync(`${dir}manifest.webmanifest`, "utf8"));

      test("the manifest says what a browser needs before it offers to install", () => {
        assert.ok(manifest.name?.length > 0, "a name");
        assert.ok(manifest.short_name?.length > 0, "a short name for under the icon");
        // Relative, because the same build is served from / in dev and from
        // /funkpost/<app>/ on Pages. An absolute start_url would install a
        // shortcut to the wrong site on one of the two.
        assert.ok(manifest.start_url?.startsWith("."), "a relative start_url");
        assert.ok(manifest.scope?.startsWith("."), "a relative scope");
        assert.match(manifest.display, /standalone|fullscreen|minimal-ui/);
      });

      test("every icon it names is really there, at the size it claims", () => {
        for (const icon of manifest.icons) {
          const file = `${dir}${icon.src.replace(/^\.\//, "")}`;
          assert.ok(existsSync(file), `${icon.src} is named but not shipped`);
          if (!file.endsWith(".png")) continue;
          const [w, h] = icon.sizes.split("x").map(Number);
          assert.deepEqual(pngSize(file), { width: w, height: h }, `${icon.src}`);
        }
      });

      test("it offers the two sizes an install prompt asks for", () => {
        const png = manifest.icons.filter((i) => i.type === "image/png");
        const sizes = png.map((i) => i.sizes);
        assert.ok(sizes.includes("192x192"), "192 for the launcher");
        assert.ok(sizes.includes("512x512"), "512 for the splash screen");
        // A maskable icon is what stops Android drawing the whole square and
        // cropping the corners off the mark.
        assert.ok(
          png.some((i) => i.purpose?.includes("maskable")),
          "one maskable",
        );
      });

      test("the page links a favicon and an apple-touch-icon", () => {
        const html = readFileSync(at(`../examples/${app}/index.html`), "utf8");
        assert.match(html, /rel="manifest"/);
        assert.match(html, /rel="apple-touch-icon"/, "iOS ignores the manifest's icons");
        assert.ok(existsSync(`${dir}apple-touch-icon.png`));
      });
    });
  }
});

describe("a link to these pages in a chat", () => {
  /**
   * A page with no Open Graph tags is a bare URL wherever somebody pastes it:
   * no title, no description, no picture. All five had none, which is a thing
   * nothing else would notice and nobody would report.
   */
  const PAGES = [
    ...APPS.map((app) => ({ app, html: at(`../examples/${app}/index.html`), dir: `../examples/${app}/public`, path: `${app}/` })),
    { app: "landing", html: at("../examples/landing/index.html"), dir: "../examples/landing", path: "" },
  ];

  for (const { app, html, dir, path } of PAGES) {
    test(`${app} says what it is, with a picture`, () => {
      const page = readFileSync(html, "utf8");
      for (const tag of ["og:title", "og:description", "og:url", "og:image", "twitter:card"]) {
        assert.match(page, new RegExp(`property="${tag}"|name="${tag}"`), `${app} is missing ${tag}`);
      }

      // Absolute, because a scraper does not run the page and several refuse
      // to resolve a relative image — and pointing at the right deploy path,
      // because an og:image that 404s is the same as having none.
      const image = page.match(/property="og:image" content="([^"]+)"/)[1];
      assert.equal(image, `https://nikrause.github.io/funkpost/${path}og.png`, `${app}'s card URL`);

      const url = page.match(/property="og:url" content="([^"]+)"/)[1];
      assert.equal(url, `https://nikrause.github.io/funkpost/${path}`, `${app}'s own URL`);

      // And the file it names is really shipped, at the size it claims.
      const file = at(`${dir}/og.png`);
      assert.ok(existsSync(file), `${app} names og.png and does not ship it`);
      assert.deepEqual(pngSize(file), { width: 1200, height: 630 }, `${app}'s card`);
    });
  }
});

describe("the same link shared in German", () => {
  /**
   * A scraper does not run the page: it has no `localStorage`, sends no useful
   * `Accept-Language`, and caches what it finds per URL. So the language
   * somebody switched on cannot reach the card, and German needs an address of
   * its own. The pages under `/de/` are generated at build time, so what is
   * checked here is the generator's output from the committed English page —
   * the same function the build calls.
   *
   * Every check below reads its needle out and compares *that*. Handing a whole
   * page to `assert.match` instead hangs the test runner while it formats the
   * failure, so a regression here would stall CI rather than report itself.
   */
  const SITE = "https://nikrause.github.io/funkpost";
  const PAGES = [
    ...APPS.map((app) => ({ app, dir: `../examples/${app}/public`, path: `${app}/` })),
    { app: "landing", dir: "../examples/landing", path: "" },
  ];

  for (const { app, dir, path } of PAGES) {
    describe(app, () => {
      const english = readFileSync(at(`../examples/${app}/index.html`), "utf8");
      const german = germanPage(english, app);
      const meta = (name) =>
        german.match(new RegExp(`<meta\\s+property="${name}"\\s+content="([^"]+)"`))?.[1];

      test("is a German page, and says so where a scraper looks", () => {
        assert.ok(german.includes('<html lang="de"'), "the document's own language");
        assert.ok(
          german.includes(`<title>${GERMAN[app].title}</title>`),
          "the German title, in the tab and in a bookmark",
        );
        assert.equal(meta("og:url"), `${SITE}/${path}de/`);
        assert.equal(meta("og:image"), `${SITE}/${path}og-de.png`);
        assert.equal(meta("og:locale"), "de_DE");
        assert.equal(meta("og:title"), GERMAN[app].title);
        assert.equal(meta("og:description"), GERMAN[app].description);
      });

      test("ships the card it names, at the size it claims", () => {
        const file = at(`${dir}/og-de.png`);
        assert.ok(existsSync(file), `${app} names og-de.png and does not ship it`);
        assert.deepEqual(pngSize(file), { width: 1200, height: 630 });
      });

      test("says once which page is which, in both directions", () => {
        // Two canonicals is worse than none, and the English page carries its
        // own set that comes across with the copy.
        const canonical = german.match(/rel="canonical" href="([^"]+)"/g) ?? [];
        assert.deepEqual(canonical, [`rel="canonical" href="${SITE}/${path}de/"`]);

        const alternates = [...german.matchAll(/hreflang="([^"]+)" href="([^"]+)"/g)];
        assert.deepEqual(
          Object.fromEntries(alternates.map((m) => [m[1], m[2]])),
          {
            de: `${SITE}/${path}de/`,
            en: `${SITE}/${path}`,
            "x-default": `${SITE}/${path}`,
          },
          "both languages and a default",
        );

        // And the English page names its twin, or a search engine sees two
        // unrelated pages and the pair drifts apart unnoticed.
        assert.ok(
          english.includes(`hreflang="de" href="${SITE}/${path}de/"`),
          `the English ${app} page does not name its German twin`,
        );
      });

      test("nothing it points at moved out from under it", () => {
        // `public/` is copied verbatim by Vite, so a reference written for the
        // page one level up would 404 here. The generator throws on any it
        // cannot rewrite; this asserts the one that must *not* be rewritten.
        const refs = [...german.matchAll(/(?:href|src)="(\.[^"]*)"/g)].map((m) => m[1]);
        const wrong = refs.filter((r) => r !== "./manifest.webmanifest" && !r.startsWith("../"));
        assert.deepEqual(wrong, [], "relative to the wrong directory");
      });
    });
  }

  test("the German landing page hands the language on", () => {
    const german = germanPage(readFileSync(at("../examples/landing/index.html"), "utf8"), "landing");
    const missing = APPS.filter((app) => !german.includes(`href="../${app}/de/"`));
    assert.deepEqual(missing, [], "a click out of German arrives in English");
  });

  for (const app of APPS) {
    test(`${app} installs from German as the German app`, () => {
      const dir = at(`../examples/${app}/public/`);
      const manifest = JSON.parse(germanManifest(readFileSync(`${dir}manifest.webmanifest`, "utf8"), app));
      const german = germanPage(readFileSync(at(`../examples/${app}/index.html`), "utf8"), app);

      // Relative to public/de/, so installing from the German page starts
      // there — an inherited start_url installs the English app instead.
      assert.ok(manifest.start_url?.startsWith("."), "a relative start_url");
      assert.equal(manifest.description, GERMAN[app].description);
      assert.ok(
        german.includes('rel="manifest" href="./manifest.webmanifest"'),
        "the German page points at the English manifest",
      );

      const wrong = manifest.icons.filter(
        (i) => !i.src.startsWith("../") || !existsSync(`${dir}${i.src.replace(/^\.\.\//, "")}`),
      );
      assert.deepEqual(wrong.map((i) => i.src), [], "icons a browser would not find");
    });
  }
});
