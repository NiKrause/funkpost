// SPDX-License-Identifier: GPL-3.0-only
/**
 * Busy time as a bitmap — one bit per grid slot, in grid order.
 *
 * A customer does not need to know *who* is booked at 14:00, only that it is
 * gone. Sending the salon's bookings would leak names to every neighbour on
 * the channel and cost bytes per booking; sending a bitmap costs one bit per
 * slot regardless. Three weeks of quarter-hours over a ten-hour day is ~840
 * bits — about 105 bytes, plus a seven-byte header. One LoRa frame.
 *
 * The mask is a **compaction, not the authority**. Live requests travel as
 * their own entries and are honoured the moment they merge; the salon folds
 * settled ones into the mask so the document does not grow without bound. A
 * receiver whose rules disagree with the mask's basis ignores it and works
 * from the entries alone — which is what `basis` is for.
 */

import { epochDay, dateFromEpochDay, toISODate, parseISODate } from "./time.js";

export const MASK_VERSION = 1;
const HEADER_BYTES = 7; // version(1) · epochDay(4) · count(2)

/**
 * @param {Object} mask
 * @param {string} mask.fromISO First civil date of the horizon
 * @param {number} mask.count Number of grid slots covered
 * @param {Iterable<number>} mask.busy Indices that are taken
 * @returns {Uint8Array}
 */
export function encodeMask({ fromISO, count, busy }) {
  if (count < 0 || count > 0xffff) throw new Error(`mask of ${count} slots is out of range`);
  const bytes = new Uint8Array(HEADER_BYTES + Math.ceil(count / 8));
  const view = new DataView(bytes.buffer);
  bytes[0] = MASK_VERSION;
  view.setUint32(1, epochDay(parseISODate(fromISO)), false);
  view.setUint16(5, count, false);

  for (const index of busy) {
    if (index < 0 || index >= count) continue; // outside the horizon: not ours to say
    bytes[HEADER_BYTES + (index >> 3)] |= 1 << (index & 7);
  }
  return bytes;
}

/**
 * @param {Uint8Array} bytes
 * @returns {{ version: number, fromISO: string, count: number,
 *   isBusy: (index: number) => boolean, busy: () => number[] }}
 */
export function decodeMask(bytes) {
  if (!bytes || bytes.length < HEADER_BYTES) throw new Error("mask is too short to be one");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = bytes[0];
  if (version !== MASK_VERSION) throw new Error(`mask version ${version} is not ${MASK_VERSION}`);
  const count = view.getUint16(5, false);
  if (bytes.length < HEADER_BYTES + Math.ceil(count / 8)) {
    throw new Error("mask claims more slots than it carries");
  }
  const fromISO = toISODate(dateFromEpochDay(view.getUint32(1, false)));

  const isBusy = (index) =>
    index >= 0 &&
    index < count &&
    (bytes[HEADER_BYTES + (index >> 3)] & (1 << (index & 7))) !== 0;

  return {
    version,
    fromISO,
    count,
    isBusy,
    busy() {
      const out = [];
      for (let i = 0; i < count; i++) if (isBusy(i)) out.push(i);
      return out;
    },
  };
}

/**
 * Does this mask describe the grid we just generated? Indices only mean
 * anything against the rules they were computed from, so a mask whose horizon
 * or length disagrees must be discarded rather than trusted — silently reading
 * someone else's index space is how a customer gets booked into a Ruhetag.
 */
export function maskMatchesGrid(mask, { fromISO, count }) {
  return Boolean(mask) && mask.fromISO === fromISO && mask.count === count;
}
