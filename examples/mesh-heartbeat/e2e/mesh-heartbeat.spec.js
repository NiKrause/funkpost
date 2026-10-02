// SPDX-License-Identifier: GPL-3.0-only
/**
 * The page around the heartbeat: a device that asks, a device that answers,
 * and a track that says where each beat went out from and what came back.
 */
import { test, expect } from "@playwright/test";
import { open, room } from "./devices.js";

// The office, and a spot about 1.2 km away — far enough that a wrong scale
// factor would show as a wrong number rather than as a rounding difference.
const OFFICE = { lat: 48.40639, lon: 12.76167 };
const OUT_THERE = { lat: 48.41500, lon: 12.77000 };

test("a beat that is answered is recorded with its place and its beat number", async ({
  context,
}) => {
  const roomId = room();
  const office = await open(context, roomId, "role=office", OFFICE);
  // It answers and it does not ask. The lamp is the page's own claim about
  // that; the log is the evidence behind it.
  await expect(office.getByTestId("beat-out")).toHaveAttribute("data-lit", "no");

  const rider = await open(context, roomId, "role=rider&every=0", OFFICE);
  await rider.getByTestId("ask-now").click();

  await expect(rider.getByTestId("track")).toContainText(/answered at once|sofort beantwortet/, {
    timeout: 20_000,
  });
  const row = rider.locator('[data-testid="track"] tbody tr').first();
  await expect(row).toHaveAttribute("data-result", "first");
  // The place, not merely a dash: a track whose points have no position is a
  // list of times, and this demo exists to produce places.
  await expect(row).toContainText("48.40639");

  // And the office says what it did: it answered. The lamp used to track only
  // beats, so the device whose entire job is answering read "nothing sent yet"
  // all day — indistinguishable, from the other end of a radio link, from one
  // that was not answering at all.
  await expect(office.getByTestId("beat-out")).toHaveAttribute("data-lit", "yes");
  await expect(office.getByTestId("beat-out")).toContainText(/echo (to|an) /);
  // It answered; it never asked — and it keeps its own record of that, which
  // is the half of every silence the riding phone cannot see.
  await expect(office.getByTestId("heard-summary")).toContainText(
    /1 (beat|Beat).*1 (answered|beantwortet)/,
  );
  await expect(office.locator('[data-testid="heard"] tbody tr')).toHaveCount(1);

  await rider.close();
  await office.close();
});

test("the stationary device says where it is once, and the distance follows", async ({
  context,
}) => {
  const roomId = room();
  const office = await open(context, roomId, "role=office", OFFICE);
  const rider = await open(context, roomId, "role=rider&every=0", OUT_THERE);
  await expect(rider.getByTestId("here")).toContainText("48.41500", { timeout: 20_000 });

  await rider.getByTestId("ask-now").click();
  await expect(rider.getByTestId("office-at")).toContainText("48.40639", { timeout: 20_000 });
  // About 1.2 km apart. This does NOT pin the scale factor and must not claim
  // to: both ends scale with the same constant, so an error cancels itself out
  // over the wire and the distance still comes out right — verified by
  // breaking it. What the scale rests on is the raw-integer case in
  // test/position.test.js. What this pins is the path: a position announced by
  // one device arrives at the other and turns into a distance.
  await expect(rider.getByTestId("office-at")).toContainText(/1\.\d\d km/);

  // Once. A second round is answered too, and costs nothing extra to answer.
  await rider.getByTestId("ask-now").click();
  await expect(rider.getByTestId("track-summary")).toContainText(/2 (beats|Beats)/, {
    timeout: 20_000,
  });
  const positionLines = await rider.locator('[data-testid="log"] li').allTextContents();
  const saidWhereItIs = positionLines.filter((line) => /is at|steht bei/.test(line));
  expect(saidWhereItIs).toHaveLength(1);

  // And the other way: the device that stays holds the ride too. The rider
  // says where it is on the first beat of *each* round — twice here, once per
  // press — so the office's own record has a place against those rows, and a
  // distance, because it knows where it is standing.
  await expect(office.getByTestId("heard")).toContainText("48.41500");
  await expect(office.getByTestId("heard")).toContainText(/1\.\d\d km/);
  await expect(office.getByTestId("heard-summary")).toContainText(/2 (with a place|mit Ort)/);

  await rider.close();
  await office.close();
});

test("nobody there is a silence, and it is written down as one", async ({ context }) => {
  const roomId = room();
  const rider = await open(context, roomId, "role=rider&every=0", OFFICE);

  await rider.getByTestId("ask-now").click();
  // Three beats and then the verdict — no answer, three rows, all red.
  await expect(rider.getByTestId("track-summary")).toContainText(/3 (beats|Beats)/, {
    timeout: 20_000,
  });
  await expect(rider.locator('[data-testid="track"] tbody tr[data-result="silent"]')).toHaveCount(3);
  await expect(rider.getByTestId("log")).toContainText("✗");
  // A silence still has a place against it: that is the whole point of
  // recording one rather than dropping it.
  await expect(rider.locator('[data-testid="track"] tbody tr').first()).toContainText("48.40639");

  await rider.close();
});

test("only on the button means nothing goes out until it is pressed", async ({ context }) => {
  const roomId = room();
  const rider = await open(context, roomId, "role=rider&every=0", OFFICE);

  // Long enough that any interval on offer would have fired several rounds.
  await rider.waitForTimeout(3000);
  await expect(rider.getByTestId("track-empty")).toBeVisible();
  await expect(rider.getByTestId("beat-out")).toHaveAttribute("data-lit", "no");

  await rider.getByTestId("ask-now").click();
  await expect(rider.getByTestId("beat-out")).toHaveAttribute("data-lit", "yes");

  await rider.close();
});

test("an office has no interval to choose, because it never asks", async ({ context }) => {
  const roomId = room();
  const page = await open(context, roomId, "role=rider&every=2");
  await expect(page.getByTestId("interval")).toBeVisible();
  await expect(page.getByTestId("ask-now")).toBeVisible();

  await page.getByTestId("role-office").check();
  // Hidden rather than greyed out: a control that cannot do anything is worse
  // than no control.
  await expect(page.getByTestId("interval")).toHaveCount(0);
  await expect(page.getByTestId("ask-now")).toHaveCount(0);

  await page.close();
});

/**
 * Channel selection, through the seam mesh-todo already found worth having:
 * the fake mesh reports no channels, and a wrong channel fails *silently* —
 * both devices transmit, neither hears the other, and nothing on either screen
 * says why. Two devices measuring each other must be on the same one, and the
 * index is per device, so a name is the only thing they can agree on.
 */
test("it moves itself onto the preferred channel, by name", async ({ context }) => {
  const roomId = room();
  const page = await open(context, roomId, "role=rider&every=0");

  // The node reports its channels one at a time, and the wanted one is not
  // first — which is the case that broke this elsewhere. Index 1, not 0, so
  // "it moved" is distinguishable from "it never left the default".
  await page.evaluate(async () => {
    await window.__nodeChannel({ index: 1, role: 1, settings: { name: "LongFast", psk: new Uint8Array([1]) } });
    await window.__nodeChannel({ index: 3, role: 2, settings: { name: "le-space.de", psk: new Uint8Array([2, 3]) } });
  });

  await expect(page.getByTestId("tx-channel")).toHaveValue("3");
  await expect(page.getByTestId("log")).toContainText("le-space.de");

  await page.close();
});

test("a channel chosen by hand is final", async ({ context }) => {
  const roomId = room();
  const page = await open(context, roomId, "role=rider&every=0");

  // Only a channel the preference does not match, so nothing has been applied
  // yet — which is the only window in which the hand guard does any work. An
  // earlier version of this test chose by hand *after* the preference had
  // landed, where `preferenceApplied` already returns early, and it stayed
  // green with the guard removed.
  await page.evaluate(async () => {
    await window.__nodeChannel({ index: 1, role: 1, settings: { name: "LongFast", psk: new Uint8Array([1]) } });
  });
  const select = page.getByTestId("tx-channel");
  await select.selectOption("1");

  // Now the preferred one arrives. It must not move a selector a person set.
  await page.evaluate(async () => {
    await window.__nodeChannel({ index: 3, role: 2, settings: { name: "le-space.de", psk: new Uint8Array([2, 3]) } });
  });
  await expect(select).toHaveValue("1");

  await page.close();
});

test("a beat cut short by a channel change is dropped, not marked a silence", async ({
  context,
}) => {
  const roomId = room();
  // A wider gap than the rest of the suite, on purpose: this test has to act
  // *between* two beats, and at the usual seventh of a second the second beat
  // lands while Playwright is still crossing into the page — which leaves a
  // row `abandon()` never claimed and fails about a race rather than about
  // the behaviour. Measured at roughly one full run in three.
  const page = await open(context, roomId, "role=rider&every=0&gap=1200");

  await page.getByTestId("ask-now").click();
  await expect(page.getByTestId("track-summary")).toContainText(/1 (beat|Beat)/, { timeout: 10_000 });

  // Mid-round, the radio moves. That place was never actually tested, so it
  // must leave no row — a red mark there would be a measurement nobody made.
  await page.evaluate(async () => {
    await window.__nodeChannel({ index: 1, role: 2, settings: { name: "le-space.de", psk: new Uint8Array([9]) } });
  });
  await expect(page.getByTestId("track-empty")).toBeVisible({ timeout: 10_000 });

  await page.close();
});

test("the ride is drawn on both screens, and the link between them", async ({ context }) => {
  // #184. The same ride on two maps: the rider draws its own track, the
  // stationary device draws what reached it — and both draw the line that is
  // being measured, because that is the thing a range test is about.
  const roomId = room();
  const office = await open(context, roomId, "role=office", OFFICE);
  const rider = await open(context, roomId, "role=rider&every=0", OUT_THERE);

  await expect(rider.getByTestId("here")).toContainText("48.41500", { timeout: 20_000 });
  await rider.getByTestId("ask-now").click();
  await expect(rider.getByTestId("track")).toContainText(/answered at once|sofort beantwortet/, {
    timeout: 20_000,
  });

  // Leaflet draws circles and lines as SVG paths in its overlay pane. One
  // beat, the station, and the dashed line between them is three.
  const riderShapes = rider.locator('[data-testid="map"] .leaflet-overlay-pane path');
  await expect(riderShapes).toHaveCount(3, { timeout: 10_000 });

  // The office has the rider's place because it arrived on the round's first
  // beat, so its map is the same picture from the other end.
  const officeShapes = office.locator('[data-testid="map"] .leaflet-overlay-pane path');
  await expect(officeShapes).toHaveCount(3, { timeout: 10_000 });

  // Tiles are served locally in this suite, so the offline banner must be
  // absent — otherwise the next test could not prove anything by its presence.
  await expect(rider.getByTestId("map-offline")).toHaveCount(0);

  await rider.close();
  await office.close();
});

test("without tiles the ride is still drawn, and the page says why", async ({ context }) => {
  // On a bicycle out of coverage this is the normal case, and an empty grey
  // square with no explanation reads as a broken map rather than a missing
  // network.
  const roomId = room();
  const rider = await open(context, roomId, "role=rider&every=0", OUT_THERE);
  await rider.route("**/tile.openstreetmap.org/**", (route) => route.abort());

  await rider.getByTestId("ask-now").click();
  await expect(rider.getByTestId("map-offline")).toBeVisible({ timeout: 20_000 });
  // Three beats of an unanswered round, the line through them, and this
  // device — all drawn from numbers already here, with no tile server
  // involved. The count is a floor rather than an exact number: what matters
  // is that the ride survives the network, not how many shapes it takes.
  const shapes = rider.locator('[data-testid="map"] .leaflet-overlay-pane path');
  await expect
    .poll(async () => await shapes.count(), { timeout: 20_000 })
    .toBeGreaterThanOrEqual(3);

  await rider.close();
});
