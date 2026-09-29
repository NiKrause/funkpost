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

const at = (rel) => fileURLToPath(new URL(rel, import.meta.url));

/** Width and height out of a PNG's IHDR, which is always the first chunk. */
function pngSize(path) {
  const bytes = readFileSync(path);
  assert.equal(bytes.subarray(1, 4).toString("ascii"), "PNG", `${path} is not a PNG`);
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

const APPS = ["mesh-todo", "mesh-calendar", "mesh-heartbeat"];

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
