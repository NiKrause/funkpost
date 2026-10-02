// SPDX-License-Identifier: GPL-3.0-only
/**
 * Will a phone install it, and will it open with no internet?
 *
 * Both matter more here than in the other demos. The device running this one
 * is in a rucksack, out of range by design — a reload halfway through a ride
 * with nothing cached ends the ride and the measurement, and an app the
 * operator has to dig out of a browser's history at the kerb is one that does
 * not get opened at all.
 *
 * test/installable.test.js checks what the manifest *says*. This checks what
 * the browser then *does* with it, which is the half that cannot be read out
 * of a file: whether the worker registers, and whether the shell is really in
 * the cache afterwards rather than merely promised.
 */
import { test, expect } from "@playwright/test";
import { WORDS } from "../src/words.js";

test("the worker registers and the shell is really cached", async ({ page }) => {
  await page.goto("/");

  // The page sets this only once `cache.addAll` has resolved. A worker that is
  // merely controlling the page is not the same as a page that will open
  // offline, and only the second one is worth claiming.
  await expect(page.locator("html")).toHaveAttribute("data-offline-ready", "true", {
    timeout: 30_000,
  });

  const kept = await page.evaluate(async () => {
    const names = await caches.keys();
    const cache = await caches.open(names[0]);
    return {
      names,
      paths: (await cache.keys()).map((r) => new URL(r.url).pathname),
      controlled: !!navigator.serviceWorker.controller,
    };
  });

  expect(kept.controlled).toBe(true);
  // One cache, and the name both the page and the worker agree on — the
  // worker deletes every other one on activate.
  expect(kept.names).toEqual(["funkpost-mesh-heartbeat-v1"]);
  expect(kept.paths).toContain("/");
  expect(kept.paths.some((p) => p.endsWith(".js"))).toBe(true);
  expect(kept.paths.some((p) => p.endsWith(".css"))).toBe(true);
});

test("everything the manifest names is actually served", async ({ page, request }) => {
  await page.goto("/");
  const manifest = await (await request.get("/manifest.webmanifest")).json();

  expect(manifest.icons.length).toBeGreaterThanOrEqual(3);
  for (const icon of manifest.icons) {
    const response = await request.get(icon.src.replace(/^\.\//, "/"));
    // The classic silent failure: an icon the manifest names and the build
    // does not ship. The page works, and the install prompt never appears.
    expect(response.status(), `${icon.src}`).toBe(200);
    expect(Number(response.headers()["content-length"] ?? 1)).toBeGreaterThan(0);
  }

  const touch = await request.get("/apple-touch-icon.png");
  expect(touch.status(), "iOS ignores the manifest and reads this").toBe(200);
});

/**
 * The German address, which exists because a scraper cannot be told a language.
 *
 * `test/installable.test.js` checks what the generator writes into `/de/`. This
 * checks the two things a file cannot show: that the page boots in German from
 * the address alone — no query, no stored choice — and that what it then caches
 * is the page somebody actually opened.
 */
test("the German address opens in German and caches itself", async ({ page, request }) => {
  await page.goto("/de/");

  // From the path alone. A reader who was sent this link has no `?lang=de` and
  // nothing in storage, and the bootstrap runs before the first paint.
  await expect(page.locator("html")).toHaveAttribute("lang", "de");
  await expect(page.getByText(WORDS.de.role.legend)).toBeVisible();

  await expect(page.locator("html")).toHaveAttribute("data-offline-ready", "true", {
    timeout: 30_000,
  });
  const paths = await page.evaluate(async () => {
    const cache = await caches.open((await caches.keys())[0]);
    return (await cache.keys()).map((r) => new URL(r.url).pathname);
  });
  // The page it came for, not only the root one level up — which is what was
  // cached before, leaving a German reader with an English shell offline.
  expect(paths).toContain("/de/");

  // And its own manifest, so installing from here installs the German app.
  const manifest = await (await request.get("/de/manifest.webmanifest")).json();
  expect(manifest.description).toMatch(/[äöüß]/);
  for (const icon of manifest.icons) {
    const at = new URL(icon.src, "http://localhost/de/").pathname;
    expect((await request.get(at)).status(), `${icon.src} → ${at}`).toBe(200);
  }
});
