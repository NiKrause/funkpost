// SPDX-License-Identifier: GPL-3.0-only
/**
 * The LED, and the heartbeat behind it.
 *
 * The LED blinks until a node is connected and another device keeping this
 * list has answered the heartbeat: one round an hour, up to five beats a
 * minute apart, ending at the first answer. Here a minute lasts 300 ms
 * (`&minute=300`), so a round takes a second and a half and the hour between
 * two rounds eighteen seconds. The schedule itself is pinned down, minute by
 * minute, in test/heartbeat.test.js; what runs here is the page around it.
 */
import { test, expect } from "@playwright/test";
import { room, openPhone } from "./phones.js";

const FAST = "&minute=300";

test("the LED blinks until another device with this list answers, and again once it goes", async ({
  context,
}) => {
  const roomId = room();
  const a = await openPhone(context, roomId, FAST);
  const led = a.getByTestId("led");

  // A node, but nothing to listen for yet.
  await expect(led).toHaveAttribute("data-state", "blinking");
  await expect(a.getByTestId("led-label")).toHaveText(/no list to listen for yet/);

  // A list and nobody else: five beats, then the verdict — still blinking.
  await a.getByRole("button", { name: "Create a list" }).click();
  await expect(a.getByTestId("led-label")).toHaveText(/no other device with this list answered/, {
    timeout: 15_000,
  });
  await expect(led).toHaveAttribute("data-state", "blinking");
  await expect(a.locator(".log")).toContainText("♥ beat 5 of 5");

  // B joins. Its first beat is answered, and it answers A: steady on both.
  const b = await openPhone(context, roomId, FAST);
  await a.getByRole("button", { name: "Invite again" }).click();
  await b.getByRole("button", { name: "Join this list" }).click();
  await expect(b.getByText(/0 entries/)).toBeVisible({ timeout: 60_000 });
  for (const page of [a, b]) {
    await expect(page.getByTestId("led")).toHaveAttribute("data-state", "steady", { timeout: 30_000 });
    await expect(page.getByTestId("led-label")).toHaveText(/another device with this list answered/);
  }

  // B goes. A's next round finds nobody, and the LED blinks again.
  await b.close();
  await expect(led).toHaveAttribute("data-state", "blinking", { timeout: 90_000 });
  await expect(a.getByTestId("led-label")).toHaveText(/no other device with this list answered/);

  await a.close();
});

test("a list made before the node: the node, connected later, carries it", async ({ context }) => {
  const roomId = room();
  // `autoconnect=0` leaves the fake node unpaired until somebody presses the
  // button, as a real one is.
  const a = await context.newPage();
  await a.goto(`/?mesh=bc&sync=1&room=${roomId}&preset=SHORT_TURBO&autoconnect=0${FAST}`);
  await expect(a.getByTestId("led-label")).toHaveText("no LoRa node connected", { timeout: 30_000 });
  await expect(a.getByTestId("led")).toHaveAttribute("data-state", "blinking");

  await a.getByRole("button", { name: "Create a list" }).click();
  await expect(a.locator(".addr")).toBeVisible({ timeout: 15_000 });
  await a.getByLabel("new todo").fill("Milch kaufen");
  await a.getByRole("button", { name: "Add", exact: true }).click();
  await expect(a.getByText("Milch kaufen")).toBeVisible({ timeout: 15_000 });
  // Nothing can carry it yet, and the page does not pretend otherwise.
  await expect(a.getByText(/changes stay here until a node carries them/)).toBeVisible();
  await expect(a.getByTestId("send-changes")).toHaveCount(0);

  // The node comes, and the list that was already there goes on the air.
  const b = await openPhone(context, roomId, FAST);
  await a.getByRole("button", { name: "Connect node" }).click();
  await expect(a.getByText("BroadcastChannel (fake mesh)", { exact: true })).toBeVisible({
    timeout: 30_000,
  });
  await expect(a.locator(".log")).toContainText("the node carries the list now — invite sent");
  await b.getByRole("button", { name: "Join this list" }).click();
  await expect(b.getByText("Milch kaufen")).toBeVisible({ timeout: 60_000 });

  for (const page of [a, b]) {
    await expect(page.getByTestId("led")).toHaveAttribute("data-state", "steady", { timeout: 30_000 });
  }

  await a.close();
  await b.close();
});
