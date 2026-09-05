// SPDX-License-Identifier: GPL-3.0-only
/**
 * Syncing the claim log over a byte courier.
 *
 * Three messages, and the first one is the point:
 *
 *     0x10 DIGEST   one small fingerprint per day of the horizon
 *     0x11 HAVE     the record keys I hold for one day
 *     0x12 RECORDS  the records you were missing
 *
 * **The greeting is constant.** A digest for a three-week horizon is 111 bytes
 * — one frame — whether two people or two thousand have ever booked. That is
 * the entire reason this exists next to the Yjs provider, whose state vector
 * grows with every author who has ever written and reached 5.9 kB, thirty
 * frames, at a thousand customers (issue #45).
 *
 * Only days that actually differ are ever discussed. A salon and a customer who
 * agree exchange **one frame and fall silent**; a customer missing one booking
 * exchanges that day's keys and that one record. Nothing is proportional to the
 * size of the book.
 *
 * Tags start at 0x10 so this can share a courier with the Yjs provider (which
 * uses 0x00–0x02 and ignores what it does not recognise, as does this).
 *
 * A digest also carries four random bytes naming the sender. On a broadcast
 * medium there is no such thing as a connection, so "is anybody there?" can
 * only be answered by having heard from them recently — and without a name, two
 * peers and one chatty peer look identical. Four bytes on a message that was
 * going out anyway buys an honest answer to the one question every user asks
 * first: is this thing on?
 */

import {
  encodeDigest,
  decodeDigest,
  divergentDays,
  encodeRecord,
  decodeRecord,
  recordId,
} from "./claimlog.js";

export const MSG_DIGEST = 0x10;
export const MSG_HAVE = 0x11;
export const MSG_RECORDS = 0x12;

/** Keep a RECORDS payload near a handful of frames rather than a hundred. */
const MAX_RECORDS_BYTES = 600;
/** A day nobody could sensibly fill; a defence against a hostile HAVE. */
const MAX_KEYS_PER_DAY = 512;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const writeKeys = (day, keys) => {
  const encoded = keys.map((key) => encoder.encode(key));
  const total = encoded.reduce((sum, key) => sum + 1 + key.length, 0);
  const bytes = new Uint8Array(1 + 4 + 2 + total);
  bytes[0] = MSG_HAVE;
  const view = new DataView(bytes.buffer);
  view.setUint32(1, day, false);
  view.setUint16(5, encoded.length, false);
  let at = 7;
  for (const key of encoded) {
    bytes[at++] = key.length;
    bytes.set(key, at);
    at += key.length;
  }
  return bytes;
};

const readKeys = (body) => {
  try {
    const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
    const day = view.getUint32(0, false);
    const count = view.getUint16(4, false);
    if (count > MAX_KEYS_PER_DAY) return null;
    const keys = [];
    let at = 6;
    for (let i = 0; i < count; i++) {
      const length = body[at++];
      if (at + length > body.length) return null;
      keys.push(decoder.decode(body.subarray(at, at + length)));
      at += length;
    }
    return { day, keys };
  } catch {
    return null;
  }
};

/**
 * @param {Object} options
 * @param {Object} options.log A claim log
 * @param {{ send: Function, onPayload: Function }} options.courier Any courier
 * @param {() => { fromDay: number, days: number }} options.horizon What we
 *   currently care about — moves forward as days pass, which is how the log
 *   forgets
 * @param {boolean} [options.announceOnStart] Publish our fingerprints on
 *   construction (default true). Without it a peer joining an existing room —
 *   somebody opening a calendar link on a phone that has never seen the book —
 *   would wait in silence for ever, because nothing else prompts it to ask.
 * @param {number} [options.minAnnounceGapMs]
 * @param {() => number} [options.now]
 * @param {(event: Object) => void} [options.onEvent]
 * @param {(record: Object) => void} [options.onChange] Fired when a record is
 *   accepted, so a UI can re-render
 */
export function createClaimSync({
  log,
  courier,
  horizon,
  peerId = globalThis.crypto.getRandomValues(new Uint8Array(4)),
  peerTimeoutMs = 120_000,
  announceOnStart = true,
  minAnnounceGapMs = 1000,
  now = () => Date.now(),
  onEvent = null,
  onChange = null,
}) {
  if (!log) throw new Error("A claim log is required");
  if (!courier || typeof courier.send !== "function" || typeof courier.onPayload !== "function") {
    throw new Error("A courier with send() and onPayload() is required");
  }
  if (typeof horizon !== "function") throw new Error("A horizon() function is required");

  let closed = false;
  let lastAnnounceAt = null;
  let lastHeardAt = null;
  const peers = new Map(); // hex id → last heard
  const stats = { payloadsSent: 0, payloadsReceived: 0, recordsAccepted: 0, recordsRejected: 0, bytesSent: 0 };

  const emit = (event) => {
    if (!onEvent) return;
    try {
      onEvent(event);
    } catch {
      /* instrumentation must never break sync */
    }
  };

  const send = (bytes) => {
    stats.payloadsSent++;
    stats.bytesSent += bytes.length;
    emit({ kind: "sent", tag: bytes[0], bytes: bytes.length });
    return Promise.resolve(courier.send(bytes)).catch((error) => emit({ kind: "error", error }));
  };

  /** Publish one fingerprint per day. Constant size; the whole point. */
  const announce = ({ force = false } = {}) => {
    if (closed) return;
    const at = now();
    if (!force && lastAnnounceAt != null && at - lastAnnounceAt < minAnnounceGapMs) return;
    lastAnnounceAt = at;
    const { fromDay, days } = horizon();
    const digest = encodeDigest(log, fromDay, days);
    const payload = new Uint8Array(1 + peerId.length + digest.length);
    payload[0] = MSG_DIGEST;
    payload.set(peerId, 1);
    payload.set(digest, 1 + peerId.length);
    send(payload);
  };

  const sendRecords = (records) => {
    let batch = [];
    let size = 0;
    const flush = () => {
      if (batch.length === 0) return;
      const total = batch.reduce((sum, r) => sum + 2 + r.length, 0);
      const payload = new Uint8Array(2 + total);
      payload[0] = MSG_RECORDS;
      payload[1] = batch.length;
      const view = new DataView(payload.buffer);
      let at = 2;
      for (const record of batch) {
        view.setUint16(at, record.length, false);
        at += 2;
        payload.set(record, at);
        at += record.length;
      }
      send(payload);
      batch = [];
      size = 0;
    };
    for (const record of records) {
      let encoded;
      try {
        encoded = encodeRecord(record);
      } catch {
        continue; // malformed on our side; never put it on the air
      }
      if (batch.length >= 255 || size + encoded.length > MAX_RECORDS_BYTES) flush();
      batch.push(encoded);
      size += encoded.length;
    }
    flush();
  };

  const hex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

  const handleDigest = (body) => {
    if (body.length < 4) return;
    const from = hex(body.subarray(0, 4));
    // Ignore our own broadcast coming back to us on a shared channel.
    if (from !== hex(peerId)) peers.set(from, now());
    const theirs = decodeDigest(body.subarray(4));
    if (!theirs) return;
    const differing = divergentDays(log, theirs);
    emit({ kind: "digest-rx", days: theirs.days, differing: differing.length });
    // Only days that actually disagree are ever named. Two peers in step
    // exchange this one frame and go quiet.
    for (const day of differing) send(writeKeys(day, log.keysFor(day)));
  };

  const handleHave = async (body) => {
    const parsed = readKeys(body);
    if (!parsed) return;
    const { day, keys } = parsed;
    const theirs = new Set(keys);

    // What they lack, they get.
    const missing = log.recordsFor(day, theirs);
    if (missing.length > 0) sendRecords(missing);

    // What we lack, we ask for — by naming what we hold, which is the same
    // message in the other direction. Terminates because each round strictly
    // shrinks the difference.
    const ours = new Set(log.keysFor(day));
    if (keys.some((key) => !ours.has(key))) send(writeKeys(day, [...ours]));
  };

  const handleRecords = async (body) => {
    if (body.length < 1) return;
    const count = body[0];
    const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
    let at = 1;
    let changed = false;
    for (let i = 0; i < count; i++) {
      if (at + 2 > body.length) return;
      const length = view.getUint16(at, false);
      at += 2;
      if (at + length > body.length) return;
      const record = decodeRecord(body.subarray(at, at + length));
      at += length;
      if (!record) {
        stats.recordsRejected++;
        continue;
      }
      // eslint-disable-next-line no-await-in-loop
      const accepted = await log.accept(record);
      if (accepted) {
        stats.recordsAccepted++;
        changed = true;
        emit({ kind: "accepted", id: record.id, recordKind: record.kind });
        if (onChange) onChange(record);
      } else {
        stats.recordsRejected++;
        emit({ kind: "rejected", id: record.id, recordKind: record.kind });
      }
    }
    // A cancellation can arrive before the request it refers to and be refused;
    // re-announcing keeps that day named until both sides really agree.
    if (changed) announce();
  };

  const unsubscribe = courier.onPayload((payload) => {
    if (closed || !payload || payload.length < 1) return;
    const tag = payload[0];
    if (tag !== MSG_DIGEST && tag !== MSG_HAVE && tag !== MSG_RECORDS) return; // not ours
    stats.payloadsReceived++;
    lastHeardAt = now();
    const body = payload.subarray(1);
    try {
      if (tag === MSG_DIGEST) handleDigest(body);
      else if (tag === MSG_HAVE) void handleHave(body);
      else void handleRecords(body);
    } catch (error) {
      emit({ kind: "error", error });
    }
  });

  // Say hello. A digest is one frame, and it is the only thing that makes a
  // late joiner's empty log fill itself.
  if (announceOnStart) announce({ force: true });

  return {
    /** Publish our day fingerprints, honouring the announce floor. */
    announce() {
      announce();
    },
    /** Publish them regardless — after a reconnect, or when the horizon moves. */
    resync() {
      announce({ force: true });
    },
    /**
     * Record something we authored and put it on the air at once. One booking
     * is one payload; it does not wait for a digest round.
     */
    publish(record) {
      log.put(record);
      sendRecords([record]);
      return record;
    },
    /** True when we hold everything the other log holds, over the horizon. */
    inStepWith(otherLog) {
      const { fromDay, days } = horizon();
      const mine = encodeDigest(log, fromDay, days);
      const theirs = encodeDigest(otherLog, fromDay, days);
      return mine.length === theirs.length && mine.every((byte, i) => byte === theirs[i]);
    },
    /**
     * Who we have heard from lately, and when we last heard anything at all.
     * Not a connection count — there is no such thing here — but the honest
     * version of the question: these peers said something recently.
     */
    presence() {
      const at = now();
      for (const [id, seen] of peers) if (at - seen > peerTimeoutMs) peers.delete(id);
      return {
        peers: [...peers.entries()].map(([id, seen]) => ({ id, agoMs: at - seen })),
        lastHeardAgoMs: lastHeardAt == null ? null : at - lastHeardAt,
      };
    },

    stats,
    close() {
      if (closed) return;
      closed = true;
      unsubscribe();
    },
  };
}

export { recordId };
