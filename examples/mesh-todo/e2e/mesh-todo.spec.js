// SPDX-License-Identifier: GPL-3.0-only
/**
 * The afternoon on the bench, automated (plan step S4 in issue #1).
 *
 * Two pages in one browser context are the two phones; a BroadcastChannel
 * plays the radio, with the same MTU and — in the lossy variant — the same
 * habit of eating frames. Physics stays untested, as it should: what runs
 * here is everything above the antenna, exactly as the demo ships it.
 */
import { test, expect, devices } from "@playwright/test";

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

  // Gate 1, direction A → B. Writing is local; the radio waits to be asked,
  // so each direction now ends with the press that spends the airtime.
  await a.getByLabel("new todo").fill("Milch kaufen");
  await a.getByRole("button", { name: "Add", exact: true }).click();
  await expect(a.getByText("Milch kaufen")).toBeVisible({ timeout: 15_000 });
  await a.getByTestId("send-changes").click();
  await expect(b.getByText("Milch kaufen")).toBeVisible({ timeout: 60_000 });

  // Direction B → A: the toggle comes back, once B sends it.
  await b.getByRole("checkbox").check();
  await b.getByTestId("send-changes").click();
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

test("the real-radio import path survives the browser (util shim guard)", async ({ page }) => {
  // Constructs a MeshDevice on a stub transport and makes its logger format a
  // line — the code that only ever ran on a phone, until it crashed there
  // with "util.formatWithOptions is not a function". The fake-mesh path never
  // imports @meshtastic/core, so only this probe keeps the hole shut.
  await page.goto("/?probe=meshtastic-core");
  await expect(page.locator('[data-probe="ok"]')).toBeVisible({ timeout: 30_000 });
});

test("the wake-lock checkbox exists on a phone and not on a desktop", async ({
  page,
  browser,
}) => {
  // Desktop (the default project): no checkbox — a desktop screen does not
  // take the radio down with it.
  await page.goto(`/?mesh=bc&room=${room()}`);
  await expect(page.getByText("BroadcastChannel (fake mesh)", { exact: true })).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByText(/keep the screen awake/)).toHaveCount(0);

  // A phone (emulated): the checkbox appears.
  const phone = await browser.newContext({ ...devices["Pixel 7"] });
  const phonePage = await phone.newPage();
  await phonePage.goto(`/?mesh=bc&room=${room()}`);
  await expect(phonePage.getByText(/keep the screen awake/)).toBeVisible({ timeout: 30_000 });
  await phone.close();
});

test("the shared channel is picked by name, wherever the node filed it", async ({ context }) => {
  const page = await openPhone(context, room());

  // What a node reports on connecting: its own channels, one at a time, in
  // index order — and the shared one is rarely index 0, because the index is
  // per-device bookkeeping. Two apps both defaulting to 0 would transmit to
  // different rooms while showing the same name to their users.
  await page.evaluate(async () => {
    const psk = (fill) => new Uint8Array(32).fill(fill);
    await window.__nodeChannel({ index: 0, role: 1, settings: { name: "", psk: psk(1) } });
    await window.__nodeChannel({ index: 2, role: 2, settings: { name: "le-space.de", psk: psk(2) } });
  });

  const select = page.locator("select");
  await expect(select).toHaveValue("2", { timeout: 8_000 });
  // And it says so — a channel that moves without a word is the same silence
  // this feature exists to prevent.
  await expect(page.locator(".log")).toContainText(/le-space\.de.*chosen automatically/);

  await page.close();
});

test("a hand-made channel choice is never overridden", async ({ context }) => {
  const page = await openPhone(context, room());

  await page.evaluate(async () => {
    const psk = (fill) => new Uint8Array(32).fill(fill);
    await window.__nodeChannel({ index: 0, role: 1, settings: { name: "", psk: psk(1) } });
    await window.__nodeChannel({ index: 1, role: 2, settings: { name: "local-mesh", psk: psk(2) } });
  });

  const select = page.locator("select");
  await select.selectOption("1");
  await expect(select).toHaveValue("1");

  // The preferred channel turns up afterwards. Moving the selector now would
  // undo a deliberate choice without telling anyone.
  await page.evaluate(async () => {
    await window.__nodeChannel({
      index: 2,
      role: 2,
      settings: { name: "le-space.de", psk: new Uint8Array(32).fill(3) },
    });
  });
  await expect(select).toHaveValue("1");

  await page.close();
});

test("changes wait for the button, and then they cross", async ({ context }) => {
  const roomId = room();
  const a = await openPhone(context, roomId);
  const b = await openPhone(context, roomId);

  await a.getByRole("button", { name: "Create a list" }).click();
  await expect(a.locator(".addr")).toBeVisible({ timeout: 15_000 });
  await a.getByRole("button", { name: "Invite again" }).click();
  await b.getByRole("button", { name: "Join this list" }).click();
  await expect(b.getByText(/0 entries/)).toBeVisible({ timeout: 60_000 });

  // Three writes, nothing sent. The button counts what is waiting, which is
  // the honest signal: "send" alone would not say whether anything is pending.
  for (const text of ["Milch", "Brot", "Butter"]) {
    await a.getByLabel("new todo").fill(text);
    await a.getByRole("button", { name: "Add", exact: true }).click();
    await expect(a.getByText(text)).toBeVisible({ timeout: 15_000 });
  }
  await expect(a.getByTestId("send-changes")).toHaveText(/Send 3 changes/);

  // The peer must still be empty — and stay empty for long enough that this is
  // a fact about the app rather than a race we happened to win.
  await b.waitForTimeout(3_000);
  await expect(b.getByText("Milch")).toHaveCount(0);
  await expect(b.getByText(/0 entries/)).toBeVisible();

  // One press carries all three: the batching this exists for.
  await a.getByTestId("send-changes").click();
  await expect(b.getByText("Milch")).toBeVisible({ timeout: 60_000 });
  await expect(b.getByText("Brot")).toBeVisible({ timeout: 20_000 });
  await expect(b.getByText("Butter")).toBeVisible({ timeout: 20_000 });

  // Nothing left waiting, and the control says so rather than staying armed.
  await expect(a.getByTestId("send-changes")).toHaveText(/Nothing to send/);
  await expect(a.getByTestId("send-changes")).toBeDisabled();

  await a.close();
  await b.close();
});
