// SPDX-License-Identifier: GPL-3.0-only
/**
 * A list's heartbeat: is another device keeping this list within radio reach,
 * whichever path carries the list right now?
 *
 * courier-sync can ask the same question (`hello` / `here`), but only while it
 * runs, and it runs only while the mesh carries the list. On the internet path
 * it is stopped and hears nothing — which is exactly when somebody wants to
 * know whether the mesh would catch the list if the internet went. So this is
 * a message of its own on the same courier, keyed by the same tag, and it
 * keeps going whichever path carries the list.
 *
 * One *round* an hour. A round is up to five beats a minute apart and ends at
 * the first answer, so one lost frame does not make a device look alone for an
 * hour. A round nobody answers makes the verdict `alone`. A beat or an echo
 * from another device with this list makes it `answered`, at once and at any
 * time: a device that comes into range announces itself with its own round.
 *
 * Wire: dag-cbor behind no prefix byte, like the founding pointer — so
 * courier-sync drops it unread, and this drops courier-sync's traffic.
 *
 *   { v: 1, t: "beat", tag, p }   is another device keeping this list?
 *   { v: 1, t: "echo", tag, p }   yes, this one
 *
 * `tag` is courier-sync's `databaseTag` (8 bytes; the address stays off the
 * air). `p` is four random bytes per heartbeat: what lets a device ignore its
 * own beat and count the others.
 */

import * as dagCbor from "@ipld/dag-cbor";
import { sameTag } from "./founding-pointer.js";

export const HEARTBEAT_VERSION = 1;

const TAG_LENGTH = 8;
const ID_LENGTH = 4;
const TYPES = new Set(["beat", "echo"]);

const defaultTimers = {
  now: Date.now,
  setTimeout: (...args) => setTimeout(...args),
  clearTimeout: (...args) => clearTimeout(...args),
};

const hex = (bytes) => [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");

/**
 * @param {Object} message
 * @param {"beat"|"echo"} message.type
 * @param {Uint8Array} message.tag courier-sync's `databaseTag(address)`
 * @param {Uint8Array} message.from the sender's four-byte id
 * @returns {Uint8Array} dag-cbor, ready for `courier.send`
 */
export function encodeHeartbeat({ type, tag, from }) {
  if (!TYPES.has(type)) throw new Error(`a heartbeat is a beat or an echo, not ${type}`);
  if (!(tag instanceof Uint8Array) || tag.length !== TAG_LENGTH) {
    throw new Error(`a heartbeat needs a ${TAG_LENGTH}-byte tag`);
  }
  if (!(from instanceof Uint8Array) || from.length !== ID_LENGTH) {
    throw new Error(`a heartbeat needs a ${ID_LENGTH}-byte sender id`);
  }
  return dagCbor.encode({ v: HEARTBEAT_VERSION, t: type, tag, p: from });
}

/**
 * Read a heartbeat, or decide these bytes are not one. `null` rather than a
 * throw: on a shared carrier most of what arrives belongs to somebody else.
 *
 * @param {Uint8Array} bytes
 * @returns {{ type: "beat"|"echo", tag: Uint8Array, from: Uint8Array } | null}
 */
export function decodeHeartbeat(bytes) {
  let message;
  try {
    message = dagCbor.decode(bytes);
  } catch {
    return null; // courier-sync traffic, another app's, or a damaged frame
  }
  if (
    !message ||
    message.v !== HEARTBEAT_VERSION ||
    !TYPES.has(message.t) ||
    !(message.tag instanceof Uint8Array) ||
    message.tag.length !== TAG_LENGTH ||
    !(message.p instanceof Uint8Array) ||
    message.p.length !== ID_LENGTH
  ) {
    return null;
  }
  return { type: message.t, tag: message.tag, from: message.p };
}

/**
 * Beat for one list on one courier.
 *
 * @param {Object} options
 * @param {{ send: Function, onPayload: Function }} options.courier the same
 *   courier courier-sync uses, started or not
 * @param {Uint8Array} options.tag the list's `databaseTag`
 * @param {number} [options.minuteMs] how long a minute is. Tests shorten it,
 *   and every interval below follows unless given on its own.
 * @param {number} [options.beatsPerRound] beats before a round gives up
 * @param {number} [options.roundEveryMs] from one round's start to the next
 * @param {number} [options.answerWindowMs] how long a round's last beat waits
 * @param {Uint8Array} [options.id] this device's four-byte id
 * @param {Object} [options.timers] injectable clock, as in the courier
 * @param {(state: Object) => void} [options.onChange] whenever the state moves
 * @param {(event: Object) => void} [options.onEvent] beat / echo / heard /
 *   round / error, for a log
 */
export function createHeartbeat({
  courier,
  tag,
  minuteMs = 60_000,
  beatsPerRound = 5,
  roundEveryMs = 60 * minuteMs,
  answerWindowMs = minuteMs / 2,
  id = globalThis.crypto.getRandomValues(new Uint8Array(ID_LENGTH)),
  timers = defaultTimers,
  onChange = () => {},
  onEvent = () => {},
}) {
  if (!courier || typeof courier.send !== "function" || typeof courier.onPayload !== "function") {
    throw new Error("A courier with send() and onPayload() is required");
  }
  if (!(tag instanceof Uint8Array) || tag.length !== TAG_LENGTH) {
    throw new Error(`a heartbeat needs a ${TAG_LENGTH}-byte tag`);
  }
  if (beatsPerRound * minuteMs + answerWindowMs >= roundEveryMs) {
    throw new Error("a round must end before the next one starts");
  }

  const self = hex(id);
  let verdict = "unknown"; // until the first round ends: "answered" or "alone"
  let beat = 0; // beats sent in the round that is running; 0 between rounds
  let rounds = 0;
  let nextRoundAt = null;
  let lastHeardAt = null;
  let lastError = null;
  const heard = new Map(); // sender id → when it was last heard
  const echoedAt = new Map(); // sender id → when it was last answered
  // Totals for the life of this heartbeat, because "nothing arrives" is two
  // questions: did it go out, and did anything come back. A round counter
  // answers neither — it counts intentions, not transmissions.
  const sent = { beats: 0, echoes: 0 };
  const received = { beats: 0, echoes: 0 };
  let beatTimer = null;
  let roundTimer = null;
  let unsubscribe = null;
  let running = false;

  const state = () => {
    const at = timers.now();
    // A peer counts until the round after next could have heard it again.
    const fresh = roundEveryMs + beatsPerRound * minuteMs;
    return {
      id: self,
      verdict,
      beat,
      beatsPerRound,
      rounds,
      nextRoundAt,
      lastHeardAgoMs: lastHeardAt == null ? null : at - lastHeardAt,
      sent: { ...sent },
      received: { ...received },
      peers: [...heard]
        .filter(([, seen]) => at - seen <= fresh)
        .map(([peer, seen]) => ({ id: peer, agoMs: at - seen })),
      lastError,
    };
  };

  const changed = () => {
    try {
      onChange(state());
    } catch {
      // a screen must not stop the heart
    }
  };
  const emit = (event) => {
    try {
      onEvent(event);
    } catch {
      // nor may a log
    }
  };

  const send = (type, options) =>
    courier.send(encodeHeartbeat({ type, tag, from: id }), options).then(
      () => {
        sent[type === "beat" ? "beats" : "echoes"] += 1;
        lastError = null;
        changed();
      },
      (error) => {
        lastError = error?.message ?? String(error);
        emit({ kind: "error", error });
        changed();
      },
    );

  const closeRound = (answered) => {
    if (beatTimer) timers.clearTimeout(beatTimer);
    beatTimer = null;
    beat = 0;
    verdict = answered ? "answered" : "alone";
    emit({ kind: "round", answered, nextRoundAt });
    changed();
  };

  const sendBeat = () => {
    beatTimer = null;
    if (!running) return;
    beat++;
    // The timer before the send: an answer can arrive while the send is still
    // running, and closing the round has to find the timer it cancels.
    beatTimer =
      beat < beatsPerRound
        ? timers.setTimeout(sendBeat, minuteMs)
        : timers.setTimeout(() => closeRound(false), answerWindowMs);
    emit({ kind: "beat", beat, of: beatsPerRound });
    changed();
    // One transmission: nobody may be there to acknowledge it, and without an
    // acknowledgement the ARQ would repeat it to exhaustion. The round is the
    // retry.
    send("beat", { rounds: 1 });
  };

  const startRound = () => {
    if (!running) return;
    rounds++;
    nextRoundAt = timers.now() + roundEveryMs;
    roundTimer = timers.setTimeout(startRound, roundEveryMs);
    beat = 0;
    sendBeat();
  };

  const hear = (message) => {
    if (!sameTag(message.tag, tag)) return; // another list on the same channel
    const from = hex(message.from);
    if (from === self) return; // a link that hands a device its own frames back
    const at = timers.now();
    heard.set(from, at);
    lastHeardAt = at;
    received[message.type === "beat" ? "beats" : "echoes"] += 1;
    emit({ kind: "heard", type: message.type, from });

    if (message.type === "beat") {
      // Answered so the other device can stop looking, but only once per half
      // minute per device: a beat is cheap, an echo storm is not. An echo is
      // never answered, or two devices would answer each other forever.
      const last = echoedAt.get(from);
      if (last == null || at - last >= minuteMs / 2) {
        echoedAt.set(from, at);
        emit({ kind: "echo", to: from });
        // The ARQ's default rounds: this device has demonstrably spoken.
        send("echo");
      }
    }

    if (beat > 0) closeRound(true); // a round ends at the first answer
    else {
      verdict = "answered";
      changed();
    }
  };

  return {
    id: self,
    state,
    start() {
      if (running) return;
      running = true;
      unsubscribe = courier.onPayload((bytes) => {
        const message = decodeHeartbeat(bytes);
        if (message) hear(message);
      });
      startRound();
    },
    stop() {
      running = false;
      if (beatTimer) timers.clearTimeout(beatTimer);
      if (roundTimer) timers.clearTimeout(roundTimer);
      beatTimer = null;
      roundTimer = null;
      beat = 0;
      if (unsubscribe) unsubscribe();
      unsubscribe = null;
    },
  };
}
