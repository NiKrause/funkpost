// SPDX-License-Identifier: GPL-3.0-only
/**
 * The afternoon on the bench, automated (plan step S4 in issue #1).
 *
 * Two pages in one browser context are the two phones; a BroadcastChannel
 * plays the radio, with the same MTU and — in the lossy variant — the same
 * habit of eating frames. Physics stays untested, as it should: what runs
 * here is everything above the antenna, exactly as the demo ships it.
 */
import { test, expect } from "@playwright/test";

const room = () => `e2e-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

async function openPhone(context, roomId, extra = "") {
  const page = await context.newPage();
  await page.goto(`/?mesh=bc&room=${roomId}&preset=SHORT_TURBO${extra}`);
  await expect(page.getByText("BroadcastChannel (fake mesh)", { exact: true })).toBeVisible({ timeout: 30_000 });
  return page;
}

async function runTheScript(context, extra) {
  const roomId = room();
  const a = await openPhone(context, roomId, extra);
  const b = await openPhone(context, roomId, extra);

  // Step 5 of the hand-test script: A creates, the invite crosses the mesh,
  // B joins and bootstraps.
  await a.getByRole("button", { name: "Create a list" }).click();
  await expect(a.locator(".addr")).toBeVisible({ timeout: 15_000 });
  const address = (await a.locator(".addr").innerText()).trim();
  await a.getByRole("button", { name: "Invite again" }).click();
  await b.getByRole("button", { name: "Join this list" }).click();
  await expect(b.getByText(/0 entries/)).toBeVisible({ timeout: 60_000 });
  await expect(b.locator(".addr")).toHaveText(address, { timeout: 15_000 });

  // Gate 1, direction A → B.
  await a.getByLabel("new todo").fill("Milch kaufen");
  await a.getByRole("button", { name: "Add" }).click();
  await expect(a.getByText("Milch kaufen")).toBeVisible({ timeout: 15_000 });
  await expect(b.getByText("Milch kaufen")).toBeVisible({ timeout: 60_000 });

  // Direction B → A: the toggle comes back.
  await b.getByRole("checkbox").check();
  await expect(a.locator("span.done")).toHaveText("Milch kaufen", { timeout: 60_000 });

  return { a, b, address };
}

test("the whole script over a clean mesh: create, invite, join, both directions", async ({
  context,
}) => {
  await runTheScript(context, "");
});

test("converges over a mesh that eats a fifth of all frames", async ({ context }) => {
  await runTheScript(context, "&loss=0.2");
});

test("creating a list with nobody listening does not hang", async ({ context }) => {
  // The regression the demo found in the courier: an announce into an empty
  // room must resolve on transmission, not wait for an acknowledgement
  // nobody can send.
  const a = await openPhone(context, room());
  await a.getByRole("button", { name: "Create a list" }).click();
  await expect(a.locator(".addr")).toBeVisible({ timeout: 5_000 });
  await expect(a.getByText(/0 entries/)).toBeVisible({ timeout: 5_000 });
});

test("gate 2 in miniature: a wiped peer re-joins and bootstraps the history", async ({
  context,
}) => {
  const { a, b } = await runTheScript(context, "");

  // Reset is a reload (memory stores drop the local copy) — then the peer
  // re-joins from a fresh invite and the existing history crosses the mesh.
  await b.reload();
  await expect(b.getByText("BroadcastChannel (fake mesh)", { exact: true })).toBeVisible({ timeout: 30_000 });
  await a.getByRole("button", { name: "Invite again" }).click();
  await b.getByRole("button", { name: "Join this list" }).click();
  await expect(b.getByText("Milch kaufen")).toBeVisible({ timeout: 60_000 });
  await expect(b.getByRole("checkbox")).toBeChecked({ timeout: 15_000 });
});
