// SPDX-License-Identifier: GPL-3.0-only
/**
 * One radio, one job — and two lamps that say what it did.
 *
 * The heartbeat is a few bytes an hour; the list sync is everything else. With
 * both switched on the beat queues behind a delta that can take minutes, so
 * the round that sent it has given up by the time it lands. The choice is
 * therefore exclusive, and this is what says so.
 */
import { test, expect } from "@playwright/test";
import { room, openPhone } from "./phones.js";

test("the radio carries one thing at a time", async ({ context }) => {
  const a = await openPhone(context, room());

  // The heartbeat is what a fresh page carries.
  await expect(a.getByTestId("carries-beat")).toBeChecked();
  await expect(a.getByTestId("carries-list")).not.toBeChecked();
  await expect(a.getByTestId("carries-none")).not.toBeChecked();

  // Choosing the list puts the heartbeat down rather than adding to it.
  await a.getByTestId("carries-list").check();
  await expect(a.getByTestId("carries-list")).toBeChecked();
  await expect(a.getByTestId("carries-beat")).not.toBeChecked();

  // And back, which must not leave the list running underneath.
  await a.getByTestId("carries-beat").check();
  await expect(a.getByTestId("carries-list")).not.toBeChecked();

  // "Nothing" stays reachable: it was, before this was one control.
  await a.getByTestId("carries-none").check();
  await expect(a.getByTestId("carries-beat")).not.toBeChecked();
  await expect(a.getByTestId("carries-list")).not.toBeChecked();
});

/**
 * A heartbeat with no list asks a different question, and says which.
 *
 * It used to refuse to start at all: the tag is the list's address, so no list
 * meant no tag and no beats — while the switch said "heartbeat on" and a field
 * log came back with both nodes configured and not one beat in it. Now the
 * question without a list is *is any device on this channel at all*, which is
 * the first thing anyone wants to know.
 *
 * The surprising half is that the two questions do not mix: different tags,
 * so a device asking about a list neither hears this nor is heard by it. That
 * is why the page says which one it is asking.
 */
test("with no list the heartbeat asks the open question, and says so", async ({ context }) => {
  const a = await openPhone(context, room());

  await expect(a.getByTestId("carries-beat")).toBeChecked();
  await expect(a.getByTestId("beat-open-question")).toBeVisible();

  // And it really beats — this is the part that used to be silent.
  await expect(a.getByTestId("ping-out")).toHaveAttribute("data-lit", "yes", { timeout: 30_000 });

  // A list changes the question, and the note goes with it.
  await a.getByRole("button", { name: "Create a list" }).click();
  await expect(a.locator(".addr")).toBeVisible({ timeout: 15_000 });
  await expect(a.getByTestId("beat-open-question")).toHaveCount(0);
  await expect(a.getByTestId("ping-out")).toHaveAttribute("data-lit", "yes", { timeout: 30_000 });
});

test("two devices with no list find each other", async ({ context }) => {
  const id = room();
  const a = await openPhone(context, id);
  const b = await openPhone(context, id);

  // Nothing is created, nothing is joined: this is the bare reachability
  // question, which is what somebody holding two phones asks first.
  for (const page of [a, b]) {
    const seen = page.getByTestId("ping-in");
    await expect(seen).toHaveAttribute("data-lit", "yes", { timeout: 30_000 });
    await expect(seen).toContainText(/\d+ B/);
  }
});

test("the outgoing lamp lights when a beat goes, and the lamps belong to the heartbeat", async ({
  context,
}) => {
  const a = await openPhone(context, room());

  // The heartbeat is a list's, keyed by its address — so there is none until
  // there is a list. That is why this creates one first.
  await a.getByRole("button", { name: "Create a list" }).click();
  await expect(a.locator(".addr")).toBeVisible({ timeout: 15_000 });

  // A round's first beat goes at once, so the outgoing lamp is lit and says
  // which of the round it was.
  const out = a.getByTestId("ping-out");
  await expect(out).toHaveAttribute("data-lit", "yes", { timeout: 30_000 });
  await expect(out).toContainText(/beat 1\/\d/);

  // Nothing has answered on an empty channel, and an unlit lamp is a state of
  // its own rather than a missing one.
  await expect(a.getByTestId("ping-in")).toHaveAttribute("data-lit", "no");

  // They describe a heartbeat; with the radio carrying the list there is none.
  await a.getByTestId("carries-list").check();
  await expect(a.getByTestId("ping-out")).toHaveCount(0);
  await expect(a.getByTestId("ping-in")).toHaveCount(0);
});

test("two devices name the beat that got through", async ({ context }) => {
  const id = room();
  const a = await openPhone(context, id);
  const b = await openPhone(context, id);

  // One list, kept by both: the heartbeat asks about a list, so both devices
  // have to be keeping the same one before they can hear each other about it.
  await a.getByRole("button", { name: "Create a list" }).click();
  await expect(a.locator(".addr")).toBeVisible({ timeout: 15_000 });
  await a.getByRole("button", { name: "Invite again" }).click();
  await b.getByRole("button", { name: "Join this list" }).click();
  await expect(b.locator(".addr")).toHaveText(
    (await a.locator(".addr").innerText()).trim(),
    { timeout: 60_000 },
  );

  // Each hears the other's beat and answers it; the answer carries the number.
  for (const page of [a, b]) {
    const seen = page.getByTestId("ping-in");
    await expect(seen).toHaveAttribute("data-lit", "yes", { timeout: 30_000 });
    await expect(seen).toContainText(/\d+ B/);
  }
});
