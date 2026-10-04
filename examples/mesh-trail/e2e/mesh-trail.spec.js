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

test("a place from minutes ago is not broadcast as if it were now", async ({ context }) => {
  // What the second walk came back with: the readout sat at 160 seconds and
  // climbing, because `watchPosition` reports changes rather than time. The
  // beacon carries no time of its own, so sending that fix would have drawn
  // this device, sharply, where it used to be.
  const roomId = room();
  const anna = await open(context, roomId, "every=1", { ...CLEARING, staleSeconds: 160 });
  await expect(anna.getByTestId("here")).toContainText("48.40639", { timeout: 20_000 });

  // The readout says so rather than only counting upwards.
  await expect(anna.getByTestId("here-stale")).toBeVisible();

  await startSending(anna);
  // A check-in sends at once — and this one must not.
  await anna
    .getByTestId("check-in")
    .getByRole("button", { name: /Come to me|Kommt zu mir/ })
    .click();
  await expect(anna.getByTestId("held-back")).toBeVisible({ timeout: 20_000 });
  await expect(anna.getByTestId("held-back")).toContainText(/160|16[0-9]/);

  await anna.close();
});

test("the page can be jumped through instead of scrolled", async ({ context }) => {
  // On a phone the map is most of the way down a column of ten cards, and
  // reaching the people list from the radio card is four flicks.
  const roomId = room();
  const anna = await open(context, roomId, "every=0", CLEARING);
  const bar = anna.getByTestId("jump");
  await expect(bar).toBeVisible();

  // Short labels, because these are pills in a row that scrolls sideways: a
  // card's own legend is a sentence and two of them fill the screen.
  await expect(bar.getByRole("link", { name: /^(Radio|Funk)$/ })).toBeVisible();
  await expect(bar.getByRole("link", { name: /^(People|Leute)$/ })).toBeVisible();

  // A jump must not put the heading under the bar it was made from.
  await bar.getByRole("link", { name: /^(People|Leute)$/ }).click();
  const covered = await anna.evaluate(() => {
    const b = document.querySelector('[data-testid="jump"]').getBoundingClientRect();
    const h = document.querySelector("#people h2").getBoundingClientRect();
    return h.top < b.bottom;
  });
  expect(covered, "the heading landed under the bar").toBe(false);

  // A card that is switched off takes its pill with it: a link to a section
  // that is not there would be a lie about the page.
  await anna.getByTestId("show-people").uncheck();
  await expect(bar.getByRole("link", { name: /^(People|Leute)$/ })).toHaveCount(0);
  await expect(bar.getByRole("link", { name: /^(Radio|Funk)$/ })).toBeVisible();

  await anna.close();
});

test("the switch list is a column of switches, not a staircase", async ({ context }) => {
  const roomId = room();
  const anna = await open(context, roomId, "every=0", CLEARING);
  // A phone, because that is where it showed: on a wide screen the six
  // switches fit on one line and nothing is wrong with any of this.
  await anna.setViewportSize({ width: 375, height: 812 });

  // Where the list starts, against where it should. Counting *distinct*
  // indents is not enough: two labels of the same width get the same centred
  // position, and a staircase of six can still show five.
  const { listLeft, firstLabel } = await anna.evaluate(() => {
    const fieldset = document.querySelector("#show fieldset");
    const style = getComputedStyle(fieldset);
    const box = fieldset.getBoundingClientRect();
    return {
      listLeft: Math.round(
        box.x + parseFloat(style.borderLeftWidth || 0) + parseFloat(style.paddingLeft || 0),
      ),
      firstLabel: Math.round(
        document.querySelector("#show label").getBoundingClientRect().x,
      ),
    };
  });
  // `.switches` sets `display: flex` without a direction, and the `fieldset`
  // rule above it says `column` — so a wrapping row was secretly a column and
  // `align-items: center` centred every label on its own width, each at its
  // own indent and none of them at the left.
  expect(firstLabel, "the list does not start at its left edge").toBe(listLeft);

  // And the legend that names the group for a screen reader stays out of
  // sight: the card already shows that name as its heading.
  const legendHidden = await anna.evaluate(() => {
    const box = document.querySelector("#show legend").getBoundingClientRect();
    return box.width <= 2 && box.height <= 2;
  });
  expect(legendHidden, "the fieldset's legend is printed under the heading").toBe(true);

  await anna.close();
});

test("an interval chosen once is still chosen next time", async ({ context }) => {
  // The point of keeping it: a walk should not start with the same four
  // decisions every time.
  const roomId = room();
  const first = await open(context, roomId, "", CLEARING);
  await startSending(first);
  await first.getByTestId("every-5").click();
  await expect(first.getByTestId("every-5")).toBeChecked();
  await first.close();

  // Same context, so the same storage — a second launch of the same app on
  // the same device.
  const again = await open(context, roomId, "", CLEARING);
  await startSending(again);
  await expect(again.getByTestId("every-5")).toBeChecked();

  // …and the address still wins, because a link that says `every=1` is
  // somebody being explicit now.
  const linked = await open(context, roomId, "every=1", CLEARING);
  await startSending(linked);
  await expect(linked.getByTestId("every-1")).toBeChecked();

  await again.close();
  await linked.close();
});

test("with no radio there is no node name, rather than an invented one", async ({ context }) => {
  // The fake mesh is two tabs, not a node. "Connected" is true; "connected to
  // C45E" would not be, and a page that prints !00000000 when it is talking to
  // nothing is worse than one that says nothing.
  const anna = await open(context, room(), "every=0", CLEARING);
  await expect(anna.getByTestId("radio-status")).toHaveAttribute("data-phase", "ready");
  await expect(anna.getByTestId("node-name")).toHaveCount(0);
  await expect(anna.getByTestId("node-id")).toHaveCount(0);
  await anna.close();
});

test("the credit mark is the 22 px the brand guide gives it", async ({ context }) => {
  // It was 327. The mark's SVG carries only a viewBox, and the size lives on
  // `.ls-credit` — which this footer was the one not to use, so the thing
  // filled the whole width of a phone.
  const anna = await open(context, room(), "every=0", CLEARING);
  const mark = await anna.evaluate(() => {
    const svg = document.querySelector("footer p.ls-credit svg");
    if (!svg) return null;
    const box = svg.getBoundingClientRect();
    return [Math.round(box.width), Math.round(box.height)];
  });
  expect(mark, "the credit line is not wearing its class").not.toBeNull();
  // 22, not the plain mark's 20: the heart needs the two pixels to read as a
  // heart, which is the brand guide's own reason.
  expect(mark).toEqual([22, 22]);
  await anna.close();
});
