// SPDX-License-Identifier: GPL-3.0-only
/**
 * The appointment book, as a Yjs document.
 *
 * The shape exists to keep concurrent writers off each other's keys. Yjs has
 * no access control, so rather than bolt one on, each role owns a map and
 * every entry is keyed by booking id:
 *
 *     shop       the rules            ← salon only
 *     requests   id → the ask         ← the customer who owns that id
 *     decisions  id → yes / no        ← salon only
 *     cancels    id → signed withdrawal ← whoever holds the capability key
 *     mask       compacted busy time  ← salon only
 *
 * Two writers therefore practically never touch the same key, and the CRDT is
 * left doing set-union — the case it is perfect at. What it cannot do is
 * decide who got a contested *slot*; that is arbitration.js, computed on read
 * and never written down.
 */

import * as Y from "yjs";
import { DEFAULT_SHOP, slotGrid, serviceById, stepsFor, bookableSlots } from "./slots.js";
import { arbitrate, busyIndices, CONFIRMED, PENDING, DECLINED } from "./arbitration.js";
import { encodeMask, decodeMask, maskMatchesGrid } from "./mask.js";
import { newToken, keysFromToken, actionMessage, verifiedCancels, toBase64Url } from "./capability.js";

const randomId = () => toBase64Url(globalThis.crypto.getRandomValues(new Uint8Array(8)));

/**
 * @param {Object} options
 * @param {Object} options.doc A `Y.Doc` — shared by the Yjs provider
 * @param {() => number} [options.now] Injectable clock
 */
export function createBookingBook({ doc, now = () => Date.now() }) {
  if (!doc) throw new Error("A Y.Doc is required");

  const shopMap = doc.getMap("shop");
  const requestMap = doc.getMap("requests");
  const decisionMap = doc.getMap("decisions");
  const cancelMap = doc.getMap("cancels");
  const maskMap = doc.getMap("mask");

  /** The rules, with anything the salon has not set falling back to defaults. */
  const shop = () => ({ ...DEFAULT_SHOP, ...Object.fromEntries(shopMap.entries()) });

  const requests = () =>
    [...requestMap.entries()].map(([id, value]) => ({ id, ...value }));

  return {
    doc,
    shop,

    /** Salon: publish or amend the rules. One small payload, any horizon. */
    setShop(patch) {
      doc.transact(() => {
        for (const [key, value] of Object.entries(patch)) shopMap.set(key, value);
      });
    },

    /** The canonical grid every device generates identically from the rules. */
    grid(fromISO, days) {
      return slotGrid(shop(), { fromISO, days });
    },

    requests,

    /**
     * Customer: ask for a time.
     *
     * Returns the **capability token** as well as the id. The token is the only
     * secret in the system, never goes into the document, and belongs in the
     * `.ics` link — losing it means losing the ability to cancel.
     */
    async request({ slotIndex, serviceId, handle, at = now(), id = randomId(), token = newToken() }) {
      const current = shop();
      const service = serviceById(current, serviceId);
      if (!service) throw new Error(`no such service: ${serviceId}`);
      const { publicKey } = await keysFromToken(token);

      requestMap.set(id, {
        slotIndex,
        // Stored, not derived: a booking should keep its meaning even if the
        // salon later changes the service's length.
        steps: stepsFor(current, service),
        serviceId,
        handle, // a first name and nothing else — the channel is public
        publicKey,
        claimedAt: at,
      });
      return { id, token };
    },

    /** Salon: answer a request. Only the salon writes here. */
    decide(id, status, { note = null, at = now() } = {}) {
      if (status !== CONFIRMED && status !== DECLINED) {
        throw new Error(`a decision is ${CONFIRMED} or ${DECLINED}, not ${status}`);
      }
      decisionMap.set(id, { status, decidedAt: at, note });
    },

    /**
     * Withdraw a booking, proving the capability rather than quoting it. An
     * unsigned or wrongly-signed cancellation is written but will simply not
     * survive verification on read — including on the writer's own screen.
     */
    async cancel(id, token, { at = now() } = {}) {
      const { sign } = await keysFromToken(token);
      const sig = await sign(actionMessage({ bookingId: id, action: "cancel", at }));
      cancelMap.set(id, { at, sig });
      return { at, sig };
    },

    /** Salon: fold settled bookings into the bitmap so the document stays small. */
    async publishMask(fromISO, days) {
      const { grid, busy } = await this.state(fromISO, days);
      const bytes = encodeMask({ fromISO, count: grid.length, busy });
      maskMap.set("bytes", bytes);
      return bytes;
    },

    /** The salon's published mask, or null when it does not fit our grid. */
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

    /**
     * Everything a screen needs, computed from the converged document.
     *
     * Async because cancellations are checked against their signatures here —
     * the one place where trust is granted, so that arbitration downstream can
     * simply believe what it is handed.
     */
    async state(fromISO, days) {
      const current = shop();
      const grid = slotGrid(current, { fromISO, days });
      const all = requests();
      const cancels = await verifiedCancels(all, cancelMap);

      const verdict = arbitrate({
        mode: current.mode,
        requests: all,
        decisions: decisionMap,
        cancels,
      });

      const busy = busyIndices(all, verdict);
      // The mask is a compaction of settled bookings, not the authority — the
      // live entries above always win. Union them so a customer who has not
      // received every entry still sees a slot as taken.
      const published = this.mask(grid, fromISO);
      if (published) for (const index of published.busy()) busy.add(index);

      return {
        shop: current,
        grid,
        busy,
        verdict,
        bookings: all.map((request) => ({ ...request, ...verdict.get(request.id) })),
        /** Slots this service could actually take, given everything above. */
        offerable(serviceId) {
          const service = serviceById(current, serviceId);
          if (!service) return [];
          return bookableSlots(current, grid, (index) => busy.has(index), service);
        },
        /** What one booking looks like to the person who made it. */
        statusOf(id) {
          return verdict.get(id) ?? null;
        },
      };
    },

    /** Statuses re-exported so a UI never spells them as strings. */
    CONFIRMED,
    PENDING,
    DECLINED,
  };
}
