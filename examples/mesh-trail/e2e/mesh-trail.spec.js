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

test("a check-in is said at once, not at the next tick", async ({ context }) => {
  // The whole reason a schedule is not enough: pressing "come to me" that
  // waits two minutes is a button nobody presses.
  const roomId = room();
  const anna = await open(context, roomId, "every=0", CLEARING);
  const bruno = await open(context, roomId, "every=0", RIDGE);
  await expect(bruno.getByTestId("here")).toContainText("48.41500", { timeout: 20_000 });
  await startSending(bruno);

  await bruno.getByTestId("check-in").getByRole("button", { name: /Come to me|Kommt zu mir/ }).click();
  await expect(anna.getByTestId("people")).toContainText(/Come to me|Kommt zu mir/, {
    timeout: 20_000,
  });
  await expect(bruno.getByTestId("my-state")).toContainText(/Come to me|Kommt zu mir/);

  // The same button unsays it.
  await bruno.getByTestId("check-in").getByRole("button", { name: /Come to me|Kommt zu mir/ }).click();
  await expect(bruno.getByTestId("my-state")).toContainText(/Fine|Alles gut/);

  await anna.close();
  await bruno.close();
});

test("the compass says how far, which way, and how old that is", async ({ context }) => {
  // The feature that still works when the tiles will not load, which in a wood
  // is the normal case.
  const roomId = room();
  const anna = await open(context, roomId, "every=0", CLEARING);
  const bruno = await open(context, roomId, "every=0", RIDGE);
  await expect(bruno.getByTestId("here")).toContainText("48.41500", { timeout: 20_000 });
  await startSending(bruno);
  await bruno.getByTestId("say-now").click();
  await expect(anna.getByTestId("people")).toBeVisible({ timeout: 20_000 });

  // Nobody followed yet.
  await expect(anna.getByTestId("compass-none")).toBeVisible();
  const id = await anna.locator("[data-peer]").first().getAttribute("data-peer");
  await anna.getByTestId(`follow-${id}`).click();

  // North-east of the clearing, about 1.2 km.
  await expect(anna.getByTestId("compass")).toContainText("NE");
  await expect(anna.getByTestId("compass")).toContainText(/1\.\d\d km/);
  await expect(anna.getByTestId("compass-age")).toContainText(/ago|vor|just now|gerade/);

  await anna.close();
  await bruno.close();
});

test("the fox is who the compass points at, without anyone choosing", async ({ context }) => {
  const roomId = room();
  const anna = await open(context, roomId, "every=0", CLEARING);
  const fox = await open(context, roomId, "every=0", RIDGE);
  await expect(fox.getByTestId("here")).toContainText("48.41500", { timeout: 20_000 });

  // The game is off by default: it is a game, not a feature of walking.
  await expect(anna.getByTestId("fox")).toHaveCount(0);
  await anna.getByTestId("show-hunt").check();
  await fox.getByTestId("show-hunt").check();
  await expect(anna.getByTestId("fox")).toContainText(/No fox|Kein Fuchs/);

  await fox.getByTestId("i-am-fox").check();
  await startSending(fox);
  await fox.getByTestId("say-now").click();

  await expect(anna.getByTestId("fox")).toContainText(/the fox is|der Fuchs ist/, {
    timeout: 20_000,
  });
  // Nobody pressed follow, and the compass is already pointing at the fox.
  await expect(anna.getByTestId("compass")).toContainText(/1\.\d\d km/);

  await anna.close();
  await fox.close();
});

test("every part of the page can be switched off, and stays off", async ({ context }) => {
  const roomId = room();
  const anna = await open(context, roomId, "every=0", CLEARING);
  await expect(anna.getByTestId("map")).toBeVisible();

  await anna.getByTestId("show-map").uncheck();
  await anna.getByTestId("show-people").uncheck();
  await expect(anna.getByTestId("map")).toHaveCount(0);
  await expect(anna.getByTestId("people-summary")).toHaveCount(0);

  // A walk is long and a reload happens; the layout is not something to set up
  // twice.
  await anna.reload();
  await expect(anna.getByTestId("radio-status")).toHaveAttribute("data-phase", "ready", {
    timeout: 30_000,
  });
  await expect(anna.getByTestId("map")).toHaveCount(0);
  await expect(anna.getByTestId("show-map")).not.toBeChecked();

  await anna.close();
});
