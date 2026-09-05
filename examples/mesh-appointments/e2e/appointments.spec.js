// SPDX-License-Identifier: GPL-3.0-only
/**
 * The demo driven the way two people would drive it: a salon on one device, a
 * customer on another, every byte between them crossing a fake mesh.
 *
 * Two pages in **one** browser context, because a BroadcastChannel does not
 * cross contexts — isolating them the way two real phones are isolated would
 * cut the very wire under test. The app namespaces its local storage by role,
 * so the two still do not read each other's.
 *
 * The date is pinned with `?today=`, so this is the same test every morning.
 */
import { test, expect } from "@playwright/test";

const MONDAY = "2026-09-07";
let room = 0;
const nextRoom = () => `e2e-${Date.now()}-${room++}`;

const open = async (context, { room: id, role, loss }) => {
  const page = await context.newPage();
  const query = new URLSearchParams({ mesh: "bc", room: id, role, today: MONDAY });
  if (loss) query.set("loss", String(loss));
  await page.goto(`/?${query}`);
  return { page };
};

/** Both sides ready and talking. */
const ready = async (page) => {
  await expect(page.getByTestId(page.url().includes("role=salon") ? "salon" : "customer")).toBeVisible({
    timeout: 30_000,
  });
};

const bookSlot = async (page, { time, service, handle }) => {
  if (service) await page.getByTestId("service").selectOption(service);
  await page.getByTestId("handle").fill(handle);
  await page.locator(`[data-slot="${time}"]`).click();
  await page.getByTestId("book").click();
};

test("the whole script: ask, approve, converge, download, parse", async ({ context }) => {
  const id = nextRoom();
  const salon = await open(context, { room: id, role: "salon" });
  await ready(salon.page);
  // Rückfrage: the salon decides, so nothing confirms itself.
  await salon.page.getByTestId("mode-ask").click();

  const guest = await open(context, { room: id, role: "customer" });
  await ready(guest.page);
  // The rules crossed the mesh — this is the Yjs plane, not a local default.
  await expect(guest.page.getByTestId("book")).toHaveText(/anfragen/, { timeout: 20_000 });

  await bookSlot(guest.page, { time: "14:00", handle: "Anna" });

  // …and the request crossed the other way, onto the salon's screen.
  const ask = salon.page.getByTestId("pending");
  await expect(ask).toContainText("Anna", { timeout: 20_000 });
  await expect(ask).toContainText("14:00");

  await expect(guest.page.getByTestId("booking")).toHaveAttribute("data-status", "pending");

  await salon.page.getByTestId("confirm").click();

  // The salon's SIGNED decision comes back and verifies on the guest's device.
  await expect(guest.page.getByTestId("booking")).toHaveAttribute("data-status", "confirmed", {
    timeout: 20_000,
  });

  // The artefact that outlives the radio session.
  const [download] = await Promise.all([
    guest.page.waitForEvent("download"),
    guest.page.getByTestId("save-ics").click(),
  ]);
  const stream = await download.createReadStream();
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  const ics = Buffer.concat(chunks).toString("utf8");

  expect(download.suggestedFilename()).toMatch(/\.ics$/);
  expect(ics).toContain("BEGIN:VCALENDAR");
  expect(ics).toContain("METHOD:PUBLISH");
  expect(ics).toContain("STATUS:CONFIRMED");
  expect(ics).toMatch(/DTSTART:20260907T\d{6}Z/);
  // Every content line must stay inside 75 octets, folded or not.
  for (const line of ics.split("\r\n").filter(Boolean)) {
    expect(Buffer.byteLength(line, "utf8")).toBeLessThanOrEqual(75);
  }
  // And the change link, unfolded, round-trips back to this booking.
  const unfolded = ics.replace(/\r\n[ \t]/g, "");
  expect(unfolded).toMatch(/URL:https:\/\/[^\r\n]+#\/b\/salon-funkpost\/[\w-]+\/[\w-]{43}/);

  await salon.page.close();
  await guest.page.close();
});

test("auto mode confirms without the salon doing anything", async ({ context }) => {
  const id = nextRoom();
  const salon = await open(context, { room: id, role: "salon" });
  await ready(salon.page);
  await salon.page.getByTestId("mode-auto").click();

  const guest = await open(context, { room: id, role: "customer" });
  await ready(guest.page);
  await expect(guest.page.getByTestId("book")).toHaveText(/buchen/, { timeout: 20_000 });

  await bookSlot(guest.page, { time: "10:30", handle: "Bert" });

  // No popup, no decision, no round trip: the slot was free and that was that.
  await expect(guest.page.getByTestId("booking")).toHaveAttribute("data-status", "confirmed", {
    timeout: 20_000,
  });
  await expect(salon.page.getByTestId("pending")).toHaveCount(0);
  await expect(salon.page.getByTestId("salon")).toContainText("Bert", { timeout: 20_000 });

  await salon.page.close();
  await guest.page.close();
});

test("a booking blocks the times it really occupies, on both screens", async ({ context }) => {
  const id = nextRoom();
  const salon = await open(context, { room: id, role: "salon" });
  await ready(salon.page);
  await salon.page.getByTestId("mode-auto").click();

  const guest = await open(context, { room: id, role: "customer" });
  await ready(guest.page);
  await bookSlot(guest.page, { time: "14:00", service: "cut", handle: "Anna" });
  await expect(guest.page.getByTestId("booking")).toHaveAttribute("data-status", "confirmed", {
    timeout: 20_000,
  });

  // 45 minutes covers three quarter-hours; and a NEW 45-minute cut may not
  // start at 13:30 or 13:45 either, because it would run into them.
  for (const time of ["13:30", "13:45", "14:00", "14:15", "14:30"]) {
    await expect(guest.page.locator(`[data-slot="${time}"]`)).toBeDisabled();
  }
  await expect(guest.page.locator('[data-slot="13:15"]')).toBeEnabled();
  await expect(guest.page.locator('[data-slot="14:45"]')).toBeEnabled();

  await salon.page.close();
  await guest.page.close();
});

test("a decline frees the slot and says why", async ({ context }) => {
  const id = nextRoom();
  const salon = await open(context, { room: id, role: "salon" });
  await ready(salon.page);
  await salon.page.getByTestId("mode-ask").click();

  const guest = await open(context, { room: id, role: "customer" });
  await ready(guest.page);
  await expect(guest.page.getByTestId("book")).toHaveText(/anfragen/, { timeout: 20_000 });
  await bookSlot(guest.page, { time: "11:00", handle: "Cem" });

  await expect(salon.page.getByTestId("pending")).toContainText("Cem", { timeout: 20_000 });
  await salon.page.getByTestId("decline").click();

  await expect(guest.page.getByTestId("booking")).toHaveAttribute("data-status", "declined", {
    timeout: 20_000,
  });
  // Declined means the time is genuinely free again, not merely marked.
  await expect(guest.page.locator('[data-slot="11:00"]')).toBeEnabled();

  await salon.page.close();
  await guest.page.close();
});

test("converges over a mesh that eats a fifth of all frames", async ({ context }) => {
  const id = nextRoom();
  const salon = await open(context, { room: id, role: "salon", loss: 0.2 });
  await ready(salon.page);
  await salon.page.getByTestId("mode-auto").click();

  const guest = await open(context, { room: id, role: "customer", loss: 0.2 });
  await ready(guest.page);
  await bookSlot(guest.page, { time: "15:30", handle: "Dora" });

  await expect(guest.page.getByTestId("booking")).toHaveAttribute("data-status", "confirmed", {
    timeout: 40_000,
  });
  await expect(salon.page.getByTestId("salon")).toContainText("Dora", { timeout: 40_000 });

  await salon.page.close();
  await guest.page.close();
});

test("the calendar link opens the booking on a device that never made it", async ({ context }) => {
  const id = nextRoom();
  const salon = await open(context, { room: id, role: "salon" });
  await ready(salon.page);
  await salon.page.getByTestId("mode-auto").click();

  const guest = await open(context, { room: id, role: "customer" });
  await ready(guest.page);
  await bookSlot(guest.page, { time: "09:45", handle: "Elif" });
  await expect(guest.page.getByTestId("booking")).toHaveAttribute("data-status", "confirmed", {
    timeout: 20_000,
  });

  const link = (await guest.page.getByTestId("change-link").textContent()).trim();
  expect(link).toContain("#/b/salon-funkpost/");
  await guest.page.close();

  // Forget it locally, so the next page knows nothing but what the link says.
  // The token in that fragment IS the capability — not a lookup key — which is
  // what lets a booking be cancelled from a phone that never made it.
  const wipe = await context.newPage();
  await wipe.goto("/");
  await wipe.evaluate((key) => localStorage.removeItem(key), `bookings:${id}:customer`);
  await wipe.close();

  const fragment = link.slice(link.indexOf("#"));
  const arriving = await context.newPage();
  await arriving.goto(`/?mesh=bc&room=${id}&today=${MONDAY}${fragment}`);

  // The record itself is not in this page's log yet; it comes over the mesh.
  await expect(arriving.getByTestId("booking")).toHaveAttribute("data-status", "confirmed", {
    timeout: 30_000,
  });
  await expect(arriving.getByTestId("my-bookings")).toContainText("09:45");

  // And the capability really works: cancel from here, and the salon sees it.
  await arriving.getByRole("button", { name: "Absagen" }).click();
  await expect(arriving.getByTestId("booking")).toHaveAttribute("data-status", "cancelled", {
    timeout: 20_000,
  });
  // The salon's agenda shows the time as free again — a cancelled booking must
  // not leave a name on a slot that can be sold.
  await expect(salon.page.getByTestId("salon")).not.toContainText("Elif", { timeout: 20_000 });

  await arriving.close();
  await salon.page.close();
});

test("a stale or foreign fragment is ignored, not obeyed", async ({ context }) => {
  const id = nextRoom();
  const page = await context.newPage();
  // A booking nobody has, with a well-formed but unknown token.
  await page.goto(`/?mesh=bc&room=${id}&today=${MONDAY}#/b/salon-funkpost/ZZZZZZZZZZZ/${"A".repeat(43)}`);
  await expect(page.getByTestId("awaiting-link")).toBeVisible({ timeout: 20_000 });
  // It waits, and shows nothing it cannot back up.
  await expect(page.getByTestId("booking")).toHaveCount(0);
  await page.close();
});

test("the app shell survives the network going away", async ({ context }) => {
  const id = nextRoom();
  const page = await context.newPage();
  await page.goto(`/?mesh=bc&room=${id}&role=customer&today=${MONDAY}`);
  await expect(page.getByTestId("customer")).toBeVisible({ timeout: 30_000 });

  // Wait for the shell to be STORED, not merely for a worker to be in charge:
  // a service worker takes control long before the cache is filled, and only
  // the second of those means the page will open without a network.
  await expect(page.locator("html")).toHaveAttribute("data-offline-ready", "true", {
    timeout: 20_000,
  });

  // Now take the network away entirely — the case of a calendar link tapped in
  // a village with no signal. Everything the page then does is radio anyway.
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByTestId("customer")).toBeVisible({ timeout: 30_000 });
  await context.setOffline(false);

  await page.close();
});

test("a booking survives a reload — the book is on the device, not in the air", async ({ context }) => {
  const id = nextRoom();
  const salon = await open(context, { room: id, role: "salon" });
  await ready(salon.page);
  await salon.page.getByTestId("mode-auto").click();

  const guest = await open(context, { room: id, role: "customer" });
  await ready(guest.page);
  await bookSlot(guest.page, { time: "16:00", handle: "Gerd" });
  await expect(guest.page.getByTestId("booking")).toHaveAttribute("data-status", "confirmed", {
    timeout: 20_000,
  });

  // Close the salon so nothing can re-send it: what comes back must come from
  // this device's own storage, not from the mesh.
  await salon.page.close();
  await guest.page.reload();

  await expect(guest.page.getByTestId("booking")).toHaveAttribute("data-status", "confirmed", {
    timeout: 20_000,
  });
  await expect(guest.page.getByTestId("my-bookings")).toContainText("16:00");
  // And the salon's own book comes back too, on its own.
  const again = await open(context, { room: id, role: "salon" });
  await expect(again.page.getByTestId("salon")).toContainText("Gerd", { timeout: 20_000 });

  await guest.page.close();
  await again.page.close();
});

test("the indicator says whether anybody is out there", async ({ context }) => {
  const id = nextRoom();
  const alone = await open(context, { room: id, role: "customer" });
  await ready(alone.page);

  const led = alone.page.getByTestId("link-state");
  await expect(led).toBeVisible();
  // Alone in the room: the radio is open, but claiming company would be a lie.
  await expect(led).toHaveAttribute("data-level", "waiting", { timeout: 15_000 });

  const salon = await open(context, { room: id, role: "salon" });
  await ready(salon.page);

  await expect(led).toHaveAttribute("data-level", "live", { timeout: 25_000 });
  await expect(led).toContainText(/Gerät/);

  await alone.page.close();
  await salon.page.close();
});
