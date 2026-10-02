// SPDX-License-Identifier: GPL-3.0-only
/**
 * Where everyone is: a position beacon for a group on one channel.
 *
 * The heartbeat next door asks *is anybody there*; this says *here I am*, on a
 * schedule, to nobody in particular. One radio, one channel, N people walking
 * — and the group size is a parameter in a way it has not been before.
 *
 * **The arithmetic that shapes everything.** A beacon is tens of bytes, which
 * at `LONG_FAST` is about half a second of air. Per device at one a minute
 * that is under 1 % duty cycle, comfortably inside the law. But the law is not
 * the binding limit here: the *channel* is shared, LoRa has no collision
 * avoidance, and ten people at one a minute are talking in roughly 8 % of the
 * wall clock. ALOHA-shaped media collapse well before they are full, so the
 * interval has to follow the group size rather than the other way round — and
 * a page offering the choice should show what the choice costs.
 *
 * **Fire and forget, deliberately.** No ARQ, no retransmission, no
 * acknowledgement. A reliability layer multiplies traffic by the number of
 * listeners, which is exactly the wrong direction in a group; a position that
 * missed is replaced by the next one anyway, and that is a better answer than
 * resending a place somebody has already walked away from.
 *
 * Wire: dag-cbor behind no prefix byte, like the heartbeat and the founding
 * pointer, so courier-sync drops it unread and the heartbeat's decoder refuses
 * it on the type.
 *
 *   { v: 1, t: "at", tag, p, pos, acc?, st? }
 *
 * `tag` is a `databaseTag`, so a group shares a name without the name going on
 * the air. `p` identifies the device. `pos` is two integers in Meshtastic's own
 * scaling — the same as the heartbeat's, so nothing is converted twice. `acc`
 * is metres of uncertainty, rounded, and it is not decoration: a dot drawn
 * from a satellite fix and one drawn from a Wi-Fi guess are hundreds of metres
 * apart, and a reader walking towards it deserves to know which it is. `st` is
 * one byte of state for a deliberate check-in outside the schedule.
 */

import * as dagCbor from "@ipld/dag-cbor";
import { sameTag } from "./founding-pointer.js";

export const BEACON_VERSION = 1;

const TAG_LENGTH = 8;
const ID_LENGTH = 4;

/** One byte, four meanings, and the reason a schedule is not enough. */
export const STATES = ["ok", "wait", "come", "help"];

const isPosition = (pos) =>
  Array.isArray(pos) &&
  pos.length === 2 &&
  Number.isInteger(pos[0]) &&
  Number.isInteger(pos[1]) &&
  // 0/0 is the Gulf of Guinea, and in practice it means no fix.
  !(pos[0] === 0 && pos[1] === 0) &&
  Math.abs(pos[0]) <= 900_000_000 &&
  Math.abs(pos[1]) <= 1_800_000_000;

/**
 * @param {Object} message
 * @param {Uint8Array} message.tag the group, as a hash
 * @param {Uint8Array} message.from this device
 * @param {[number, number]} message.pos Meshtastic scaling
 * @param {number} [message.accuracy] metres, rounded; omitted when unknown
 * @param {string} [message.state] one of STATES; omitted for a scheduled beacon
 * @returns {Uint8Array}
 */
export function encodeBeacon({ tag, from, pos, accuracy = null, state = null }) {
  if (!(tag instanceof Uint8Array) || tag.length !== TAG_LENGTH) {
    throw new Error(`a beacon needs a ${TAG_LENGTH}-byte tag`);
  }
  if (!(from instanceof Uint8Array) || from.length !== ID_LENGTH) {
    throw new Error(`a beacon needs a ${ID_LENGTH}-byte sender`);
  }
  if (!isPosition(pos)) throw new Error("a beacon without a place is not a beacon");
  const message = { v: BEACON_VERSION, t: "at", tag, p: from, pos };
  // Rounded to whole metres and capped: a fix good to a kilometre and one good
  // to ten kilometres are the same news, and the second costs more bytes.
  if (Number.isFinite(accuracy) && accuracy >= 0) {
    message.acc = Math.min(65_535, Math.round(accuracy));
  }
  if (state != null) {
    const index = STATES.indexOf(state);
    if (index === -1) throw new Error(`not a state: ${state}`);
    // Zero is "ok" and the default, so it rides for free by being absent.
    if (index > 0) message.st = index;
  }
  return dagCbor.encode(message);
}

/**
 * @returns {{ tag: Uint8Array, from: Uint8Array, pos: [number, number],
 *   accuracy: number|null, state: string }|null} null for anything that is not
 *   one of ours — another protocol on the same channel, a newer version, a
 *   message that lost a byte on the air
 */
export function decodeBeacon(bytes) {
  let message;
  try {
    message = dagCbor.decode(bytes);
  } catch {
    return null; // not dag-cbor at all, which on a shared channel is normal
  }
  if (!message || typeof message !== "object") return null;
  if (message.v !== BEACON_VERSION || message.t !== "at") return null;
  if (!(message.tag instanceof Uint8Array) || message.tag.length !== TAG_LENGTH) return null;
  if (!(message.p instanceof Uint8Array) || message.p.length !== ID_LENGTH) return null;
  if (!isPosition(message.pos)) return null;
  return {
    tag: message.tag,
    from: message.p,
    pos: [message.pos[0], message.pos[1]],
    accuracy: Number.isInteger(message.acc) ? message.acc : null,
    // An older or newer peer may say nothing, or something we do not know. A
    // state we cannot read is not a reason to drop a position.
    state: STATES[message.st] ?? "ok",
  };
}

/** Does this beacon belong to the group we are walking with? */
export function sameGroup(message, tag) {
  return !!message && sameTag(message.tag, tag);
}

/**
 * What a group costs, so a page can say it before somebody chooses.
 *
 * `bytes` defaults to 49, which is a scheduled beacon carrying a good fix —
 * measured, not assumed, and pinned in test/beacon.test.js. A beacon with no
 * accuracy is 44 and one carrying a state as well is 53, so the default is the
 * shape a walk actually sends. The
 * share is of what this carrier was measured to move, not of the legal duty
 * cycle: those are two different ceilings and the second is not the one that
 * bites first in a group.
 *
 * @param {Object} options
 * @param {number} options.people how many are walking, including this one
 * @param {number} options.everyMin the interval each of them sends on
 * @param {number} [options.bytes] a beacon on the wire
 * @param {number} [options.carrierBytesPerMin] measured goodput
 *
 * Both figures are rounded from the exact rate rather than from each other, so
 * the displayed minute times sixty need not be the displayed hour. The hour is
 * the one that is right.
 */
export function groupAirtime({ people, everyMin, bytes = 49, carrierBytesPerMin = 500 }) {
  if (!(people > 0) || !(everyMin > 0)) return null;
  const perMinute = (people * bytes) / everyMin;
  return {
    perMinute: Math.round(perMinute),
    perHour: Math.round(perMinute * 60),
    share: Math.round((perMinute / carrierBytesPerMin) * 100),
  };
}
