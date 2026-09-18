// SPDX-License-Identifier: GPL-3.0-only
/**
 * P10: internet first, the mesh when it goes (#82), steps 3 and 4.
 *
 * Both carriers are real here and both are on this machine: the internet one
 * runs over a libp2p relay Playwright starts on 127.0.0.1 — its address is
 * baked into the build, so the page never asks the registry — and the radio is
 * the same BroadcastChannel as everywhere else. Then the context goes offline:
 * the radio does not notice, the internet path does.
 *
 * What is under test is the judgement, not the plumbing. The page must notice
 * the loss by asking the network rather than believing a flag, and must *ask*
 * before moving the log onto a carrier that spends a rationed budget.
 */
import { test, expect } from "@playwright/test";
import { room, openPhone } from "./phones.js";

// The two pages must meet through the relay and not directly. Playwright's
// offline switch is the browser's network stack, and WebRTC does not go
// through it: two tabs of one browser keep their direct link across the
// "outage", and then nothing has been taken away to detect. Without host
// candidates WebRTC cannot form that link — as close as one machine gets to
// two villages. Top-level, because a launch flag makes Playwright start its
// own worker for the file.
test.use({
  launchOptions: { args: ["--force-webrtc-ip-handling-policy=disable_non_proxied_udp"] },
});

// Longer than the suite's two minutes: a run here waits for a join over the
// relay, then for an outage that is only believed once a dial has failed, and
// a CI runner does all of that while the mesh suite runs beside it.
test.describe.configure({ timeout: 240_000 });

test("the internet carries it; when it goes, the page notices and asks first", async ({
  context,
}) => {
  // Nothing may leave this machine — a demo that has quietly grown a
  // dependency on a deployed relay or a public gateway fails here rather than
  // in the field.
  const strayed = [];
  await context.route(
    (url) => !["localhost", "127.0.0.1"].includes(url.hostname),
    async (route) => {
      strayed.push(new URL(route.request().url()).href);
      await route.abort();
    },
  );

  const roomId = room();
  const a = await openPhone(context, roomId, "&ip=1");
  const b = await openPhone(context, roomId, "&ip=1");

  await a.getByRole("button", { name: "Create a list" }).click();
  await expect(a.locator(".addr")).toBeVisible({ timeout: 15_000 });
  await a.getByRole("button", { name: "Invite again" }).click();
  await b.getByRole("button", { name: "Join this list" }).click();
  await expect(b.getByText(/0 entries/)).toBeVisible({ timeout: 90_000 });

  // The invite crossed the air; the log does not. A write that arrives with no
  // press on "Send changes" can only have come over IP — on the mesh path the
  // same write waits for the button, which the mesh suite proves.
  await expect(a.getByTestId("carried-by")).toContainText("the internet");
  await a.getByLabel("new todo").fill("Milch kaufen");
  await a.getByRole("button", { name: "Add", exact: true }).click();
  await expect(b.getByText("Milch kaufen")).toBeVisible({ timeout: 90_000 });

  // The internet goes. The BroadcastChannel is inside the browser and keeps
  // working — which is the situation the whole feature is for.
  await context.setOffline(true);

  // Step 3: noticed, and said why — a dial failed, not a flag flipped.
  await expect(a.getByTestId("carried-by")).toContainText("internet gone", { timeout: 90_000 });
  await expect(a.locator(".log")).toContainText(/internet gone — no peer answers/);

  // Step 4: asked. Until somebody answers, the log stays where it is: the
  // radio spends a rationed budget, and moving onto it is not a decision code
  // may take on its own.
  await expect(a.getByTestId("mesh-offer")).toBeVisible({ timeout: 30_000 });
  await expect(a.getByTestId("mesh-offer")).toContainText(/Continue over the LoRa mesh/);
  await expect(a.getByTestId("carried-by")).toContainText("the internet");

  // Both readers answer, and the log moves.
  await expect(b.getByTestId("mesh-offer")).toBeVisible({ timeout: 90_000 });
  await a.getByTestId("accept-mesh").click();
  await b.getByTestId("accept-mesh").click();
  await expect(a.getByTestId("carried-by")).toContainText("the mesh", { timeout: 30_000 });
  await expect(b.getByTestId("carried-by")).toContainText("the mesh", { timeout: 30_000 });
  await expect(a.getByTestId("mesh-offer")).toHaveCount(0);

  // And the afternoon goes on over the radio: a change, a press, an arrival.
  await a.getByLabel("new todo").fill("Brot");
  await a.getByRole("button", { name: "Add", exact: true }).click();
  await a.getByTestId("send-changes").click();
  await expect(b.getByText("Brot")).toBeVisible({ timeout: 90_000 });

  expect(strayed).toEqual([]);

  await context.setOffline(false);
  await a.close();
  await b.close();
});

test("a browser claiming to be offline is not evidence, and raises no offer", async ({
  context,
}) => {
  // Why step 3 is a probe and not a flag: `navigator.onLine` reports the
  // interface. It is false on a machine whose peers are all reachable, and
  // true behind a captive portal that reaches nobody. Here it lies in the
  // direction that costs airtime, and must be ignored.
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "onLine", { get: () => false, configurable: true });
  });

  const roomId = room();
  const a = await openPhone(context, roomId, "&ip=1");
  const b = await openPhone(context, roomId, "&ip=1");

  await a.getByRole("button", { name: "Create a list" }).click();
  await expect(a.locator(".addr")).toBeVisible({ timeout: 15_000 });
  await a.getByRole("button", { name: "Invite again" }).click();
  await b.getByRole("button", { name: "Join this list" }).click();
  await expect(b.getByText(/0 entries/)).toBeVisible({ timeout: 90_000 });

  await a.getByLabel("new todo").fill("Milch kaufen");
  await a.getByRole("button", { name: "Add", exact: true }).click();
  await expect(b.getByText("Milch kaufen")).toBeVisible({ timeout: 90_000 });

  // Two probe intervals of the browser insisting it is offline, and the page
  // still has not asked to move onto the radio.
  await a.waitForTimeout(10_000);
  await expect(a.getByTestId("mesh-offer")).toHaveCount(0);
  await expect(a.getByTestId("carried-by")).toContainText("the internet");
  await expect(a.getByTestId("carried-by")).not.toContainText("internet gone");

  await a.close();
  await b.close();
});
