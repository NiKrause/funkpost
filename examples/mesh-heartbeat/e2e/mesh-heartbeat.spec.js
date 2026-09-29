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

  // And the office really did stay quiet the whole time.
  await expect(office.getByTestId("beat-out")).toHaveAttribute("data-lit", "no");
  await expect(office.getByTestId("track-empty")).toBeVisible();

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
