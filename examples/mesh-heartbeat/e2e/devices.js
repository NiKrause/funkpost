// SPDX-License-Identifier: GPL-3.0-only
/**
 * The two devices on the bench: a page each, in one browser context, talking
 * over a BroadcastChannel instead of a radio.
 *
 * `gap=150` makes a beat gap a seventh of a second, so a whole three-beat
 * round takes under half a second instead of the fifty-two the page ships.
 * The schedule itself is pinned minute by minute in test/heartbeat.test.js;
 * what runs here is the page around it.
 *
 * The position is stubbed per page rather than set on the context, and that is
 * not a stylistic choice: `context.setGeolocation` moves *every* page in the
 * context at once, and both devices live in one context because a
 * BroadcastChannel does not cross them. A range test in which both ends are
 * always in the same place cannot fail the way a wrong scale factor fails.
 */
import { expect } from "@playwright/test";

export const room = () => `e2e-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
export const FAST = "gap=150";

/**
 * A 1×1 transparent PNG, served for every map tile.
 *
 * Nothing here is testing OpenStreetMap, and a suite that fetches real tiles
 * on every run is both slow and rude to a volunteer-funded service. Serving
 * them locally also keeps the map's offline banner honest: it appears when
 * tiles *fail*, which one test asks for on purpose by aborting them instead.
 */
const TILE = Buffer.from(
  // Generated rather than copied: the one-pixel PNG that gets pasted around
  // the internet as "transparent" is RGBA 0,0,255,127 — a half-opaque blue —
  // and it painted every screenshot of this map bright blue before anyone
  // looked at the bytes.
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=",
  "base64",
);

export async function serveTiles(page) {
  await page.route("**/tile.openstreetmap.org/**", (route) =>
    route.fulfill({ contentType: "image/png", body: TILE }),
  );
}

export async function open(context, roomId, query = "", position = null) {
  const page = await context.newPage();
  await serveTiles(page);
  if (position) await pinTo(page, position);
  // A `gap=` in the query wins, because `URLSearchParams.get` takes the first
  // occurrence and this one would otherwise be unoverridable. A test that has
  // to act *between* two beats needs a wider gap, not a faster one.
  const gap = /(^|&)gap=/.test(query) ? "" : `${FAST}&`;
  await page.goto(`/?mesh=bc&room=${roomId}&preset=SHORT_TURBO&${gap}log=1&${query}`);
  await expect(page.getByTestId("radio-status")).toHaveAttribute("data-phase", "ready", {
    timeout: 30_000,
  });
  return page;
}

/**
 * One page, one place, for as long as it lives.
 *
 * `watchPosition` is what the page calls, and what it does with the fix is the
 * thing under test — so the stub answers exactly as a browser would, once,
 * and then stays quiet like a phone that is not moving.
 */
async function pinTo(page, { lat, lon }) {
  await page.addInitScript(
    ([latitude, longitude]) => {
      Object.defineProperty(navigator, "geolocation", {
        configurable: true,
        value: {
          watchPosition(onFix) {
            setTimeout(
              () => onFix({ coords: { latitude, longitude }, timestamp: Date.now() }),
              0,
            );
            return 1;
          },
          clearWatch() {},
          getCurrentPosition(onFix) {
            onFix({ coords: { latitude, longitude }, timestamp: Date.now() });
          },
        },
      });
    },
    [lat, lon],
  );
}
