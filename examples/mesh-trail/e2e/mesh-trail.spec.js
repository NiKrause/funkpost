// SPDX-License-Identifier: GPL-3.0-only
/**
 * A walk with radios: two devices, each saying where it is, each drawing the
 * other's trail.
 */
import { test, expect } from "@playwright/test";
import { open, room, refusePosition, serveTiles } from "./devices.js";

const CLEARING = { lat: 48.40639, lon: 12.76167 };
const RIDGE = { lat: 48.41500, lon: 12.77000 }; // about 1.2 km away

/** Turn on sending, accepting the public-channel warning if one is shown. */
async function startSending(page) {
  const accept = page.getByTestId("accept-public");
  if (await accept.isVisible().catch(() => false)) await accept.check();
  await page.getByTestId("broadcast").check();
}

test("each device draws the other, and says how far away it is", async ({ context }) => {
  const roomId = room();
  const anna = await open(context, roomId, "every=0", CLEARING);
  const bruno = await open(context, roomId, "every=0", RIDGE);
  await expect(anna.getByTestId("here")).toContainText("48.40639", { timeout: 20_000 });
  await expect(bruno.getByTestId("here")).toContainText("48.41500", { timeout: 20_000 });

  await startSending(anna);
  await startSending(bruno);
  await anna.getByTestId("say-now").click();
  await bruno.getByTestId("say-now").click();

  // Anna hears Bruno and places him, with the distance she can work out
  // herself because she knows where she is.
  await expect(anna.getByTestId("people")).toBeVisible({ timeout: 20_000 });
  await expect(anna.getByTestId("people")).toContainText(/1\.\d\d km/);
  await expect(anna.getByTestId("people-summary")).toContainText(/1 (device|Gerät) (heard|gehört)/);
  // …and draws him: his dot and her own ring are two shapes in the overlay.
  await expect(anna.locator('[data-testid="map"] .leaflet-overlay-pane path')).toHaveCount(2, {
    timeout: 10_000,
  });

  await expect(bruno.getByTestId("people")).toContainText(/1\.\d\d km/);

  await anna.close();
  await bruno.close();
});

test("a device draws nobody it has switched off", async ({ context }) => {
  const roomId = room();
  const anna = await open(context, roomId, "every=0", CLEARING);
  const bruno = await open(context, roomId, "every=0", RIDGE);
  await expect(bruno.getByTestId("here")).toContainText("48.41500", { timeout: 20_000 });

  await startSending(bruno);
  await bruno.getByTestId("say-now").click();
  await expect(anna.getByTestId("people")).toBeVisible({ timeout: 20_000 });
  await expect(anna.locator('[data-testid="map"] .leaflet-overlay-pane path')).toHaveCount(2);

  // Everyone is drawn until somebody says otherwise.
  await anna.locator('[data-testid="people"] li input[type="checkbox"]').first().uncheck();
  await expect(anna.getByTestId("people-summary")).toContainText(/0 (drawn|gezeichnet)/);
  await expect(anna.locator('[data-testid="map"] .leaflet-overlay-pane path')).toHaveCount(1);

  await anna.close();
  await bruno.close();
});

test("sending is off until somebody turns it on", async ({ context }) => {
  // A page that broadcasts a live position should not start doing it because
  // somebody opened a link.
  const roomId = room();
  const anna = await open(context, roomId, "every=1", CLEARING);
  await expect(anna.getByTestId("broadcast")).not.toBeChecked();
  await expect(anna.getByTestId("broadcast-state")).toContainText(/listens|hört zu/);
  // No interval to choose yet either: it is not sending anything.
  await expect(anna.getByTestId("interval")).toHaveCount(0);

  await startSending(anna);
  await expect(anna.getByTestId("interval")).toBeVisible();

  await anna.close();
});

test("what a group costs is on the page before anyone chooses", async ({ context }) => {
  const roomId = room();
  const anna = await open(context, roomId, "every=1", CLEARING);
  await startSending(anna);
  // Alone, at a minute: one device is 20 % of what this carrier was measured
  // to move. The count follows the devices actually heard.
  await expect(anna.getByTestId("cost")).toContainText(/1 (device|Gerät)/);
  await expect(anna.getByTestId("cost")).toContainText("%");

  await anna.close();
});

test("a browser with no position still draws everyone else", async ({ context }) => {
  const roomId = room();
  const bruno = await open(context, roomId, "every=0", RIDGE);
  const blind = await context.newPage();
  await serveTiles(blind);
  await refusePosition(blind, 1);
  await blind.goto(`/?mesh=bc&room=${roomId}&preset=SHORT_TURBO&gap=150&log=1&every=0`);

  await startSending(bruno);
  await bruno.getByTestId("say-now").click();

  await expect(blind.getByTestId("fix-trouble")).toBeVisible({ timeout: 20_000 });
  // It cannot put itself on the map, and it draws Bruno all the same.
  await expect(blind.getByTestId("people")).toContainText(/heard|gehört/, { timeout: 20_000 });
  await expect(blind.locator('[data-testid="map"] .leaflet-overlay-pane path')).toHaveCount(1);

  await bruno.close();
  await blind.close();
});
