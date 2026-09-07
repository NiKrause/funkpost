// SPDX-License-Identifier: GPL-3.0-only
/**
 * The claim log: bookings as an expiring set of immutable records.
 *
 * ## Why this exists instead of a CRDT
 *
 * The Yjs plane greets a peer by publishing a **state vector**, and a Yjs state
 * vector is O(authors who have ever written) and never shrinks — measured at
 * **5.9 kB for a thousand customers, unchanged after deleting every booking**
 * (issue #45). Thirty LoRa frames to say hello would spend a EU-868 hour's
 * whole duty cycle on greetings. Yjs is not at fault: it is built for a handful
 * of collaborators, and every customer's browser session is a permanent new
 * author.
 *
 * So bookings move to a structure shaped like the problem instead:
 *
 * - **Records are immutable and self-describing**, so merging is set union —
 *   the only thing the old design actually used Yjs for.
 * - **Records are bucketed by the day of their slot**, and the summary is one
 *   small digest per day. That summary is **O(horizon), not O(writers)** — 111
 *   bytes for three weeks whether two people or two thousand have booked.
 * - **Expiry is forgetting.** A bucket the horizon has passed is dropped by
 *   everyone, on every announce; no tombstones, no client ids to remember for
 *   ever. A CRDT cannot forget, and appointments are nothing but a thing that
 *   expires. What makes it hold is the `floor` below: dropping a day is not
 *   enough on its own, because a peer who still has it will offer it back.
 *
 * What does *not* change: `arbitration.js` decides who got a contested slot,
 * exactly as before. That was always substrate-independent, and this file is
 * the proof.
 *
 * ## Authority is a signature, not a convention
 *
 * The old shape kept writers off each other's keys by agreement. Here the salon
 * has an identity, and a **decision that is not signed by the salon's key is
 * not a decision** — it is discarded on read, on every device. A cancellation
 * must likewise be signed by the booking's own capability key. Requests are
 * deliberately unsigned: forging one only creates a booking, which anyone
 * within radio range of a public channel can do anyway, and a signature per
 * request would double its airtime. The channel key remains the real boundary.
 */

import { epochDay } from "./time.js";
import { verifyAction, actionMessage, toBase64Url, fromBase64Url } from "./capability.js";

export const KIND_REQUEST = 0;
export const KIND_DECISION = 1;
export const KIND_CANCEL = 2;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/* ── records on the wire ──────────────────────────────────────────────────
 * [kind:1][jsonLen:2][json][binary tail]
 * The tail keeps 32-byte keys and 64-byte signatures raw rather than paying
 * base64's third again for the largest fields in the record.
 */

const TAIL_BYTES = { [KIND_REQUEST]: 32, [KIND_DECISION]: 64, [KIND_CANCEL]: 64 };

export function encodeRecord(record) {
  const { kind } = record;
  const tail =
    kind === KIND_REQUEST ? record.publicKey : record.sig;
  const expected = TAIL_BYTES[kind];
  if (!(tail instanceof Uint8Array) || tail.length !== expected) {
    throw new Error(`a ${kind === KIND_REQUEST ? "request" : "signed"} record carries ${expected} bytes`);
  }
  const { kind: _k, publicKey: _p, sig: _s, ...fields } = record;
  const json = encoder.encode(JSON.stringify(fields));

  const bytes = new Uint8Array(3 + json.length + tail.length);
  bytes[0] = kind;
  new DataView(bytes.buffer).setUint16(1, json.length, false);
  bytes.set(json, 3);
  bytes.set(tail, 3 + json.length);
  return bytes;
}

export function decodeRecord(bytes) {
  try {
    if (!bytes || bytes.length < 3) return null;
    const kind = bytes[0];
    const expected = TAIL_BYTES[kind];
    if (expected === undefined) return null;
    const jsonLen = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(1, false);
    if (bytes.length !== 3 + jsonLen + expected) return null;
    const fields = JSON.parse(decoder.decode(bytes.subarray(3, 3 + jsonLen)));
    const tail = bytes.slice(3 + jsonLen);
    return kind === KIND_REQUEST
      ? { kind, ...fields, publicKey: tail }
      : { kind, ...fields, sig: tail };
  } catch {
    return null; // a shared channel carries other people's traffic
  }
}

/**
 * The set key. A booking has one request, at most one decision and at most one
 * cancellation, so a later duplicate is a re-send or a salon that answered
 * twice — resolved deterministically rather than appended.
 */
export function recordId(record) {
  return record.kind === KIND_REQUEST ? `r:${record.id}` : `${record.kind}:${record.id}`;
}

/* ── the digest ───────────────────────────────────────────────────────────
 * Per day: a 32-bit XOR of each record key's hash, plus the count.
 *
 * XOR because it must not depend on the order records arrived in, and because
 * it updates incrementally as records land. The count rides along so that a
 * hash collision — which XOR alone would hide, and which would then look like
 * agreement — still shows up as a difference. A false *match* is the only
 * dangerous outcome here; a false mismatch merely costs one extra exchange.
 *
 * **The count is one byte, and saturates at 255.** Past 256 records in a single
 * day, two genuinely different days can report the same count — so the count
 * stops adding information and the 32-bit XOR carries the comparison alone.
 * Sync does not break, it only loses its second opinion. Worth stating plainly
 * because the claim this structure was chosen for is *"constant in the number
 * of writers"*, and that is true of the **size**; the precision has a ceiling.
 * A salon cannot reach it — 256 appointments in one day — which is why one byte
 * was the right trade rather than an oversight (#70).
 */

const hash32 = (text) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
};

const DIGEST_HEADER = 6; // version(1) · fromDay(4) · dayCount(1)
const PER_DAY = 5; // hash(4) · count(1)
export const DIGEST_VERSION = 1;

/**
 * @param {Object} log a claim log
 * @param {number} fromDay first epoch day of the horizon
 * @param {number} days
 * @returns {Uint8Array} constant size — 111 bytes for a three-week horizon,
 *   whether two people or two thousand have ever booked
 */
export function encodeDigest(log, fromDay, days) {
  if (days < 1 || days > 255) throw new Error(`a horizon of ${days} days is out of range`);
  const bytes = new Uint8Array(DIGEST_HEADER + days * PER_DAY);
  const view = new DataView(bytes.buffer);
  bytes[0] = DIGEST_VERSION;
  view.setUint32(1, fromDay, false);
  bytes[5] = days;

  for (let i = 0; i < days; i++) {
    const bucket = log.bucket(fromDay + i);
    let xor = 0;
    for (const key of bucket.keys()) xor = (xor ^ hash32(key)) >>> 0;
    view.setUint32(DIGEST_HEADER + i * PER_DAY, xor, false);
    bytes[DIGEST_HEADER + i * PER_DAY + 4] = Math.min(255, bucket.size);
  }
  return bytes;
}

export function decodeDigest(bytes) {
  if (!bytes || bytes.length < DIGEST_HEADER) return null;
  if (bytes[0] !== DIGEST_VERSION) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const fromDay = view.getUint32(1, false);
  const days = bytes[5];
  if (bytes.length !== DIGEST_HEADER + days * PER_DAY) return null;
  const entries = [];
  for (let i = 0; i < days; i++) {
    entries.push({
      day: fromDay + i,
      xor: view.getUint32(DIGEST_HEADER + i * PER_DAY, false),
      count: bytes[DIGEST_HEADER + i * PER_DAY + 4],
    });
  }
  return { fromDay, days, entries };
}

/** Days where our view and theirs disagree — the only ones worth talking about. */
export function divergentDays(log, theirs) {
  if (!theirs) return [];
  const ours = decodeDigest(encodeDigest(log, theirs.fromDay, theirs.days));
  return theirs.entries
    .filter((them, i) => {
      // A day we have forgotten is not a disagreement to be settled. Our bucket
      // for it is empty and theirs is not, which reads exactly like a day we
      // are missing records for — so without this the expiry boundary would
      // generate work instead of saving it.
      if (them.day < log.floor) return false;
      return ours.entries[i].xor !== them.xor || ours.entries[i].count !== them.count;
    })
    .map((entry) => entry.day);
}

/* ── the log ──────────────────────────────────────────────────────────── */

/**
 * @param {Object} [options]
 * @param {Uint8Array|null} [options.salonKey] The shop's public key. Decisions
 *   not signed by it are discarded — this is the access control Yjs could not
 *   give us, and it costs one verification per decision.
 * @param {() => number} [options.now]
 */
export function createClaimLog({ salonKey = null, now = () => Date.now() } = {}) {
  /** epochDay → Map<recordKey, record> */
  const days = new Map();
  /**
   * The day before which this log has forgotten, and refuses to remember again.
   *
   * Without it, forgetting is a loop rather than an expiry: we drop a day, a
   * peer whose clock is behind still names it in a digest, we notice the
   * "divergence", fetch the records back, and drop them again on the next
   * announce — paying airtime each time to undo our own pruning. `0` means
   * nothing has been forgotten yet, which is where every log starts.
   */
  let floor = 0;
  let shopKey = salonKey;
  const putCbs = new Set();
  const forgetCbs = new Set();

  const bucketFor = (day, create = false) => {
    let bucket = days.get(day);
    if (!bucket && create) {
      bucket = new Map();
      days.set(day, bucket);
    }
    return bucket ?? new Map();
  };

  /**
   * Two decisions for one booking (a salon answering from two devices) resolve
   * the way arbitration would: the earlier one stands, and identical timestamps
   * fall through to the signature bytes so every device picks the same one.
   */
  const preferred = (existing, incoming) => {
    if (!existing) return incoming;
    if (incoming.kind === KIND_REQUEST) return existing; // requests are immutable
    const a = existing.decidedAt ?? existing.at ?? 0;
    const b = incoming.decidedAt ?? incoming.at ?? 0;
    if (b !== a) return b < a ? incoming : existing;
    return toBase64Url(incoming.sig) < toBase64Url(existing.sig) ? incoming : existing;
  };

  return {
    /** @returns {Map<string, Object>} the day's records — never null */
    bucket(day) {
      return bucketFor(day);
    },

    /** The expiry boundary: nothing before this day is held, or accepted. */
    get floor() {
      return floor;
    },

    get salonKey() {
      return shopKey;
    },
    /** The salon's identity arrives with the rules; adopt it when it does. */
    setSalonKey(key) {
      shopKey = key;
    },

    /**
     * Add a record we authored. Trusted by construction — `accept()` is the
     * door for anything that came off the air.
     */
    put(record) {
      const day = record.day;
      const bucket = bucketFor(day, true);
      const key = recordId(record);
      const kept = preferred(bucket.get(key), record);
      const changed = bucket.get(key) !== kept;
      bucket.set(key, kept);
      if (changed) for (const cb of putCbs) cb(kept, key);
      return record;
    },

    /** Called whenever a record is stored — how persistence keeps up. */
    onPut(cb) {
      putCbs.add(cb);
      return () => putCbs.delete(cb);
    },

    /** Called with the keys dropped by {@link forgetBefore}. */
    onForget(cb) {
      forgetCbs.add(cb);
      return () => forgetCbs.delete(cb);
    },

    /**
     * Take a record that arrived from a peer, if it earns it.
     *
     * This is the one place trust is granted, so everything downstream —
     * arbitration especially — can simply believe what it holds.
     *
     * @returns {Promise<boolean>} whether it was accepted
     */
    async accept(record) {
      if (!record || typeof record.day !== "number" || typeof record.id !== "string") return false;

      // Expired, and it stays expired. A peer offering a day everyone has
      // dropped is behind rather than right, and taking it back would only
      // mean dropping it again — see `floor`. This is also the honest answer
      // to a device that has been offline past the horizon: those days are
      // gone here too, and it cannot catch up on them.
      if (record.day < floor) return false;

      if (record.kind === KIND_DECISION) {
        // Only the salon decides. Without its key we cannot tell, so we refuse
        // rather than guess — a decision believed on hearsay is a double booking.
        if (!shopKey) return false;
        const ok = await verifyAction(shopKey, record.sig, {
          bookingId: record.id,
          action: `decide:${record.status}`,
          at: record.decidedAt,
        });
        if (!ok) return false;
      }

      if (record.kind === KIND_CANCEL) {
        const request = bucketFor(record.day).get(`r:${record.id}`);
        // A cancellation for a booking nobody has cannot be checked, so it is
        // not accepted. It will be, once the request arrives and the peer
        // re-offers it — the digest keeps naming that day until both agree.
        if (!request) return false;
        const ok = await verifyAction(request.publicKey, record.sig, {
          bookingId: record.id,
          action: "cancel",
          at: record.at,
        });
        if (!ok) return false;
      }

      this.put(record);
      return true;
    },

    /** Every record for a day, encoded — what a peer gets when it asks. */
    recordsFor(day, exclude = new Set()) {
      return [...bucketFor(day)]
        .filter(([key]) => !exclude.has(key))
        .map(([, record]) => record);
    },

    keysFor(day) {
      return [...bucketFor(day).keys()];
    },

    /**
     * Forget everything before `day`. This is the whole reason for the design:
     * a booking from last spring is not history to be preserved, it is noise,
     * and every device drops it at the same boundary.
     */
    forgetBefore(day) {
      // Never backwards: a horizon that jumped forward once (a clock correcting
      // itself, say) must not un-forget on the next call.
      floor = Math.max(floor, day);
      const gone = [];
      for (const key of [...days.keys()]) {
        if (key < day) {
          gone.push(...days.get(key).keys());
          days.delete(key);
        }
      }
      if (gone.length > 0) for (const cb of forgetCbs) cb(gone);
      return gone.length;
    },

    /** The three shapes arbitration wants, over a horizon. */
    view(fromDay, dayCount) {
      const requests = [];
      const decisions = new Map();
      const cancels = new Map();
      for (let i = 0; i < dayCount; i++) {
        for (const record of bucketFor(fromDay + i).values()) {
          if (record.kind === KIND_REQUEST) requests.push(record);
          else if (record.kind === KIND_DECISION) decisions.set(record.id, record);
          else cancels.set(record.id, record);
        }
      }
      return { requests, decisions, cancels };
    },

    get size() {
      let total = 0;
      for (const bucket of days.values()) total += bucket.size;
      return total;
    },

    /** Days we hold anything for — for tests and for a status line. */
    days() {
      return [...days.keys()].sort((a, b) => a - b);
    },

    now,
  };
}

/** Convenience: the epoch day a slot's instant falls on, in the shop's zone. */
export function dayOfSlot(startMs, tz) {
  const at = new Date(startMs);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
  const [year, month, day] = parts.split("-").map(Number);
  return epochDay({ year, month, day });
}

export { toBase64Url, fromBase64Url, actionMessage };
