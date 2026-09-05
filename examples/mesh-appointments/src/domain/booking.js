// SPDX-License-Identifier: GPL-3.0-only
/**
 * The appointment book: rules in a CRDT, bookings in a claim log.
 *
 * The split is deliberate and was measured into existence (issue #45).
 *
 * **Rules stay in Yjs.** The salon's opening hours, services and mode are
 * written by a handful of stable devices and genuinely benefit from merge.
 * There, a state vector is tens of bytes and Yjs is exactly the right tool.
 *
 * **Bookings moved out.** Every customer session is a permanent new Yjs author,
 * and a Yjs state vector is O(authors, for ever) — 5.9 kB and thirty LoRa
 * frames per greeting at a thousand customers, unchanged even after deleting
 * every booking. The claim log summarises the same information as one digest
 * per day: **111 bytes for three weeks, whatever the number of writers**, and
 * it forgets yesterday instead of remembering it for ever.
 *
 * What survived the substrate change untouched: `arbitration.js`, `slots.js`,
 * `mask.js`, `capability.js`, `ics.js`, `link.js`. That was the claim made when
 * they were written, and this file is where it got tested.
 *
 * Two things improved on the way:
 *
 * - **Bookings carry their absolute start time**, not an index into whichever
 *   horizon happened to be on screen. A booking now means the same thing next
 *   week, and changing `slotMinutes` no longer reinterprets the past.
 * - **Authority is a signature.** A decision not signed by the salon's key is
 *   not a decision — checked on every device, including the one that wrote it,
 *   so the rule cannot be broken locally either.
 */

import { DEFAULT_SHOP, slotGrid, serviceById, stepsFor, bookableSlots } from "./slots.js";
import { arbitrate, busyIndices, CONFIRMED, PENDING, DECLINED, CANCELLED, SUPERSEDED } from "./arbitration.js";
import { encodeMask, decodeMask, maskMatchesGrid } from "./mask.js";
import {
  newToken,
  keysFromToken,
  actionMessage,
  toBase64Url,
  fromBase64Url,
} from "./capability.js";
import { KIND_REQUEST, KIND_DECISION, KIND_CANCEL, dayOfSlot } from "./claimlog.js";
import { buildICS, icsFilename } from "./ics.js";
import { bookingLink, DEFAULT_BASE } from "./link.js";
import { epochDay, parseISODate } from "./time.js";

const randomId = () => toBase64Url(globalThis.crypto.getRandomValues(new Uint8Array(8)));

/**
 * @param {Object} options
 * @param {Object} options.doc A `Y.Doc` holding the shop rules
 * @param {Object} options.log A claim log holding the bookings
 * @param {Object} [options.sync] A claim sync; when present, authored records
 *   go on the air immediately instead of waiting for a digest round
 * @param {() => number} [options.now]
 */
export function createBookingBook({ doc, log, sync = null, now = () => Date.now() }) {
  if (!doc) throw new Error("A Y.Doc is required for the shop rules");
  if (!log) throw new Error("A claim log is required for the bookings");

  const shopMap = doc.getMap("shop");
  const maskMap = doc.getMap("mask");

  const shop = () => ({ ...DEFAULT_SHOP, ...Object.fromEntries(shopMap.entries()) });

  const publish = (record) => (sync ? sync.publish(record) : log.put(record));

  /** Keep the log's idea of who the salon is in step with the rules. */
  const syncSalonKey = () => {
    const encoded = shopMap.get("salonKey");
    if (encoded && !log.salonKey) log.setSalonKey(fromBase64Url(encoded));
  };

  /**
   * Map absolute start times onto the grid currently on screen.
   *
   * A record that lands on no grid slot is NOT dropped. It used to be, and the
   * result was a booking that simply vanished from the phone that made it —
   * silently, because a filtered record cannot report itself missing. A booking
   * is a fact with an absolute time; whether today's grid happens to contain
   * that time is a question about the view, not about the booking.
   */
  const project = (grid, records) => {
    const indexByStart = new Map(grid.map((slot) => [slot.startMs, slot.index]));
    return records.map((record) => {
      const slotIndex = indexByStart.get(record.startMs);
      return { ...record, slotIndex: slotIndex ?? null, onGrid: slotIndex !== undefined };
    });
  };

  const horizonOf = (fromISO, days) => ({
    fromDay: epochDay(parseISODate(fromISO)),
    days: days ?? shop().horizonDays,
  });

  return {
    doc,
    log,
    shop,

    /** Salon: publish or amend the rules. Still Yjs — few writers, real merges. */
    setShop(patch) {
      doc.transact(() => {
        for (const [key, value] of Object.entries(patch)) shopMap.set(key, value);
      });
      syncSalonKey();
    },

    /**
     * Salon: adopt an identity. Its public half goes into the rules, so every
     * device can check that a decision really came from the salon; the token
     * stays on the salon's own device and is the only thing that can decide.
     *
     * Refuses to replace a *different* key already in the rules. The salon's
     * identity lives in one browser, so opening the salon on a second laptop
     * would otherwise mint a new key, publish it, and quietly strip the first
     * device of its authority — every decision it had signed would stop
     * verifying, on every device, with nothing on screen to explain it. Pass
     * `takeOver` to do it deliberately.
     */
    async becomeSalon(token = newToken(), { takeOver = false } = {}) {
      const { publicKey } = await keysFromToken(token);
      const encoded = toBase64Url(publicKey);
      const existing = shopMap.get("salonKey");
      if (existing && existing !== encoded && !takeOver) {
        throw new Error(
          "this shop already has a salon key on another device — pass takeOver to replace it, " +
            "which invalidates every decision the other device has signed",
        );
      }
      this.setShop({ salonKey: encoded });
      log.setSalonKey(publicKey);
      return token;
    },

    grid(fromISO, days) {
      return slotGrid(shop(), { fromISO, days });
    },

    /**
     * Customer: ask for a time.
     *
     * The record carries an absolute `startMs`, so it survives the horizon
     * moving, and the capability's public key, so a later cancellation can be
     * checked against it. The token comes back to the caller and never enters
     * the log — it belongs in the `.ics` link and nowhere else.
     */
    async request({ fromISO, days, slotIndex, serviceId, handle, at = now(), id = randomId(), token = newToken() }) {
      const current = shop();
      const service = serviceById(current, serviceId);
      if (!service) throw new Error(`no such service: ${serviceId}`);
      const grid = slotGrid(current, { fromISO, days });
      const slot = grid[slotIndex];
      if (!slot) throw new Error(`slot ${slotIndex} is outside the horizon starting ${fromISO}`);
      const { publicKey } = await keysFromToken(token);

      publish({
        kind: KIND_REQUEST,
        id,
        day: dayOfSlot(slot.startMs, current.tz),
        startMs: slot.startMs,
        steps: stepsFor(current, service),
        serviceId,
        handle, // a first name and nothing else — the channel is public
        claimedAt: at,
        publicKey,
      });
      return { id, token };
    },

    /**
     * Salon: answer a request, and prove it. Goes through the same verification
     * as a decision arriving from the air, so an unsigned or wrongly-signed one
     * is refused on the device that wrote it too.
     */
    async decide(id, status, { salonToken, note = null, at = now() } = {}) {
      if (status !== CONFIRMED && status !== DECLINED) {
        throw new Error(`a decision is ${CONFIRMED} or ${DECLINED}, not ${status}`);
      }
      if (!salonToken) throw new Error("only the salon decides, and it must sign");
      const request = this.find(id);
      if (!request) throw new Error(`no such booking: ${id}`);

      const { sign } = await keysFromToken(salonToken);
      const sig = await sign(actionMessage({ bookingId: id, action: `decide:${status}`, at }));
      const record = { kind: KIND_DECISION, id, day: request.day, status, decidedAt: at, note, sig };

      if (!(await log.accept(record))) {
        throw new Error("that decision is not signed by this shop's key");
      }
      if (sync) sync.publish(record);
      return record;
    },

    /** Withdraw a booking, proving the capability rather than quoting it. */
    async cancel(id, token, { at = now() } = {}) {
      const request = this.find(id);
      if (!request) throw new Error(`no such booking: ${id}`);
      const { sign } = await keysFromToken(token);
      const sig = await sign(actionMessage({ bookingId: id, action: "cancel", at }));
      const record = { kind: KIND_CANCEL, id, day: request.day, at, sig };

      if (!(await log.accept(record))) {
        throw new Error("that cancellation is not signed by this booking's key");
      }
      if (sync) sync.publish(record);
      return record;
    },

    /** The request record for a booking, wherever in the log it sits. */
    find(id) {
      for (const day of log.days()) {
        const record = log.bucket(day).get(`r:${id}`);
        if (record) return record;
      }
      return null;
    },

    /**
     * Salon: publish busy time as a bitmap.
     *
     * This is no longer about document size — the claim log forgets on its own.
     * It is about **privacy**: a customer learns that 14:00 is gone without
     * receiving anybody's name.
     */
    async publishMask(fromISO, days) {
      const { grid, busy } = await this.state(fromISO, days);
      const bytes = encodeMask({ fromISO, count: grid.length, busy });
      maskMap.set("bytes", bytes);
      return bytes;
    },

    mask(grid, fromISO) {
      const bytes = maskMap.get("bytes");
      if (!bytes) return null;
      let decoded;
      try {
        decoded = decodeMask(bytes);
      } catch {
        return null;
      }
      return maskMatchesGrid(decoded, { fromISO, count: grid.length }) ? decoded : null;
    },

    /** Everything a screen needs, computed from what we currently hold. */
    async state(fromISO, days) {
      syncSalonKey();
      const current = shop();
      const grid = slotGrid(current, { fromISO, days });
      const { fromDay, days: dayCount } = horizonOf(fromISO, days);
      const raw = log.view(fromDay, dayCount);

      // Trust was granted at the door (log.accept), so arbitration can simply
      // believe what it is handed — the same contract as before.
      const requests = project(grid, raw.requests);
      // Only what sits on the grid can contend for a slot on it; everything is
      // still arbitrated, so an off-grid booking keeps a real status.
      const onGrid = requests.filter((r) => r.onGrid);
      const verdict = arbitrate({
        mode: current.mode,
        requests: onGrid,
        decisions: raw.decisions,
        cancels: raw.cancels,
      });
      for (const record of requests) {
        if (!record.onGrid && !verdict.has(record.id)) {
          verdict.set(record.id, { status: CONFIRMED, reason: null });
        }
      }

      const busy = busyIndices(onGrid, verdict);
      const published = this.mask(grid, fromISO);
      if (published) for (const index of published.busy()) busy.add(index);

      return {
        shop: current,
        grid,
        busy,
        verdict,
        bookings: requests.map((request) => ({ ...request, ...verdict.get(request.id) })),
        /** Held, but not on the grid being shown — a view problem, not a loss. */
        offGrid: requests.filter((request) => !request.onGrid),
        offerable(serviceId) {
          const service = serviceById(current, serviceId);
          if (!service) return [];
          return bookableSlots(current, grid, (index) => busy.has(index), service);
        },
        statusOf(id) {
          return verdict.get(id) ?? null;
        },
      };
    },

    /**
     * The calendar file — unchanged in every respect that matters, which was
     * the point of keeping it substrate-independent.
     */
    async icsFor(id, { fromISO, days, token = null, shopId = "salon", base = DEFAULT_BASE, stampMs, role = "customer" } = {}) {
      const request = this.find(id);
      if (!request) throw new Error(`no such booking: ${id}`);

      const current = shop();
      const service = serviceById(current, request.serviceId);
      const state = await this.state(fromISO, days);
      const status = state.statusOf(id)?.status;
      const cancelled = status === CANCELLED || status === DECLINED || status === SUPERSEDED;

      const { fromDay, days: dayCount } = horizonOf(fromISO, days);
      const raw = log.view(fromDay, dayCount);
      const sequence = (raw.decisions.has(id) ? 1 : 0) + (raw.cancels.has(id) ? 1 : 0);

      const text = buildICS({
        uid: `${id}@funkpost`,
        startMs: request.startMs,
        endMs: request.startMs + service.minutes * 60_000,
        summary: `${service.label} — ${current.name}`,
        location: current.location ?? null,
        url: token ? bookingLink({ shopId, bookingId: id, token, base }) : null,
        note: role === "salon" ? `Kundin/Kunde: ${request.handle}` : null,
        sequence,
        stampMs,
        method: cancelled ? "CANCEL" : "PUBLISH",
        organizer: current.name,
        attendee: request.handle,
      });

      return {
        text,
        filename: icsFilename({ summary: service.label, startMs: request.startMs }),
        sequence,
        cancelled,
      };
    },

    CONFIRMED,
    PENDING,
    DECLINED,
  };
}
