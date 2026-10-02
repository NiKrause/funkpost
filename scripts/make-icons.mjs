// SPDX-License-Identifier: GPL-3.0-only
/**
 * The PNGs a manifest names, rendered from the SVGs beside them.
 *
 * Chrome will not offer to install a page whose manifest names an icon the
 * build does not ship, and it says nothing an operator would see — which is
 * why `test/installable.test.js` reads the sizes out of the PNG headers rather
 * than trusting them. Those PNGs had to come from somewhere, and until now
 * that somewhere was outside the repository: the next demo would have had to
 * rediscover how.
 *
 * Chromium rather than a conversion library, because Playwright is already a
 * dependency here and an SVG rendered by the browser that will display it is
 * the one rendering that cannot disagree with itself.
 *
 *   node scripts/make-icons.mjs examples/mesh-trail
 */
import { chromium } from "@playwright/test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const SHOTS = [
  // The social card is not square: 1200×630 is what every scraper crops to,
  // and a link with no picture is a link nobody clicks.
  { from: "og.svg", to: "og.png", width: 1200, height: 630 },
  { from: "og-de.svg", to: "og-de.png", width: 1200, height: 630 },
  { from: "icon.svg", to: "icon-512.png", size: 512 },
  { from: "icon.svg", to: "icon-192.png", size: 192 },
  { from: "icon.svg", to: "apple-touch-icon.png", size: 180 },
  { from: "icon-maskable.svg", to: "icon-maskable-512.png", size: 512 },
  { from: "favicon.svg", to: "favicon-32.png", size: 32 },
];

const app = process.argv[2];
if (!app) {
  console.error("usage: node scripts/make-icons.mjs examples/<demo>");
  process.exit(1);
}
// The demos keep their art in public/; the landing page is copied rather
// than bundled and keeps its own beside index.html. Without this the landing
// card was the one image in the repository nobody could regenerate.
/** How close to the edge a line may come. A scraper may crop a few pixels. */
const MARGIN = 60;

const dir = existsSync(resolve(app, "public")) ? resolve(app, "public") : resolve(app);

const browser = await chromium.launch();
try {
  const skipped = [];
  const clipped = [];
  for (const { from, to, size, width = size, height = size } of SHOTS) {
    // A source that is not there is not an error: the landing page has a card
    // and no app icons, because it is a page rather than an app. What a
    // *manifest* names and the build does not ship is caught where it matters,
    // by test/installable.test.js reading the PNG headers.
    if (!existsSync(resolve(dir, from))) {
      skipped.push(from);
      continue;
    }
    const svg = readFileSync(resolve(dir, from), "utf8");
    const page = await browser.newPage({
      viewport: { width, height },
      // Device scale 1 and an explicit viewport: the PNG must be exactly the
      // size the manifest claims, and the test reads that out of the header.
      deviceScaleFactor: 1,
    });
    await page.setContent(
      `<!doctype html><meta charset="utf-8">` +
        `<style>html,body{margin:0;padding:0;width:${width}px;height:${height}px;overflow:hidden}` +
        `svg{display:block;width:${width}px;height:${height}px}</style>${svg}`,
    );
    writeFileSync(resolve(dir, to), await page.screenshot({ omitBackground: false }));

    // A card whose text runs off the canvas: the browser clips it, the PNG
    // looks finished, and the first person to see the missing half is whoever
    // the link was shared with. The landing card had shipped like that in
    // English, and the German line ran 267px past the edge. Measured in the
    // browser that drew it, since no rule of thumb survives a long German
    // compound. MARGIN, not zero, because scrapers crop a few pixels.
    const spills = await page.evaluate(
      (margin) =>
        [...document.querySelectorAll("text")]
          .map((t) => ({ right: Math.round(t.getBBox().x + t.getBBox().width), text: t.textContent }))
          .filter((b) => b.right > window.innerWidth - margin),
      MARGIN,
    );
    for (const { right, text } of spills) clipped.push(`${from}: "${text}" ends at ${right} of ${width}`);

    await page.close();
    console.log(`${to.padEnd(24)} ${width}×${height}`);
  }
  if (skipped.length) console.log(`no ${[...new Set(skipped)].join(", ")} here`);
  if (clipped.length) {
    console.error(`\n${clipped.length} line(s) past the edge:`);
    for (const line of clipped) console.error(`  ${line}`);
    process.exitCode = 1;
  }
} finally {
  await browser.close();
}
