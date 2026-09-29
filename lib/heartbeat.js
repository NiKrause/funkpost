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
 *   { v: 1, t: "beat", tag, p, n }        is another device keeping this list?
 *   { v: 1, t: "echo", tag, p, n, pos }   yes, this one — and here is where
 *
 * `n` is which beat of the round this is, and an echo carries back the `n` it
 * answers. That is what turns "somebody is there" into "somebody heard my
 * third beat" — and the third beat is two minutes of airtime after the first,
 * so the number is the cost of being heard, not a detail. A peer on an older
 * version sends none; the number is then simply unknown rather than wrong.
 *
 * `tag` is courier-sync's `databaseTag` (8 bytes; the address stays off the
 * air). `p` is four random bytes per heartbeat: what lets a device ignore its
 * own beat and count the others.
 *
 * `pos` is optional and its rhythm is the caller's choice. `positionEvery:
 * "once"` is the device that stays: two integers in Meshtastic's own scaling,
 * fifteen bytes measured, and then never again — it has nothing to add by
 * repeating itself. `positionEvery: "round"` is the device that moves: the
 * **first beat of each round** carries where it is, so the far end can keep
 * the ride as well, at fifteen bytes a round rather than fifteen a beat. An
 * older peer reads the message and ignores the field, which is why this could
 * be added without a version.
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
 * @param {number} [message.n] which beat of the round, or the beat an echo
 *   answers. Left out when unknown, which is what an older peer sends.
 * @param {[number, number]} [message.pos] where the sender is, as the two
 *   integers Meshtastic scales a position into. Left out by everything that
 *   moves, and by everything that does not know.
 * @returns {Uint8Array} dag-cbor, ready for `courier.send`
 */
export function encodeHeartbeat({ type, tag, from, n, pos }) {
  if (!TYPES.has(type)) throw new Error(`a heartbeat is a beat or an echo, not ${type}`);
  if (!(tag instanceof Uint8Array) || tag.length !== TAG_LENGTH) {
    throw new Error(`a heartbeat needs a ${TAG_LENGTH}-byte tag`);
  }
  if (!(from instanceof Uint8Array) || from.length !== ID_LENGTH) {
    throw new Error(`a heartbeat needs a ${ID_LENGTH}-byte sender id`);
  }
  const message = { v: HEARTBEAT_VERSION, t: type, tag, p: from };
  // Only when it is a real beat number: a zero or a fraction on the wire would
  // read as an answer to a beat that never went out.
  if (Number.isInteger(n) && n > 0) message.n = n;
  // 0/0 is refused rather than sent: it is a real place in the Gulf of Guinea,
  // and it is also what a node reports before it has seen a satellite. A
  // receiver cannot tell those apart, so the sender must.
  if (isPosition(pos)) message.pos = [pos[0], pos[1]];
  return dagCbor.encode(message);
}

/** Two integers, in range, and not the null island a fixless node reports. */
const isPosition = (pos) =>
  Array.isArray(pos) &&
  pos.length === 2 &&
  Number.isInteger(pos[0]) &&
  Number.isInteger(pos[1]) &&
  !(pos[0] === 0 && pos[1] === 0) &&
  Math.abs(pos[0]) <= 900_000_000 &&
  Math.abs(pos[1]) <= 1_800_000_000;

/**
 * Read a heartbeat, or decide these bytes are not one. `null` rather than a
 * throw: on a shared carrier most of what arrives belongs to somebody else.
 *
 * @param {Uint8Array} bytes
 * @returns {{ type: "beat"|"echo", tag: Uint8Array, from: Uint8Array,
 *   n: number | null, pos: [number, number] | null } | null}
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
  return {
    type: message.t,
    tag: message.tag,
    from: message.p,
    n: Number.isInteger(message.n) && message.n > 0 ? message.n : null,
    // Checked on the way in as well as on the way out. A peer is not a
    // promise, and a position that arrives malformed should read as "it did
    // not say" rather than plot a point somewhere it never was.
    pos: isPosition(message.pos) ? [message.pos[0], message.pos[1]] : null,
  };
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
 * @param {number} [options.beatsPerRound] beats before a round gives up, or
 *   `0` for a device that only answers — see below
 * @param {number|null} [options.roundEveryMs] from one round's start to the
 *   next, or `null` for a device that asks only when it is asked to —
 *   `beatNow()` is then the only thing that opens a round
 * @param {number} [options.answerWindowMs] how long a round's last beat waits
 * @param {Uint8Array} [options.id] this device's four-byte id
 * @param {Object} [options.timers] injectable clock, as in the courier
 * @param {() => [number, number] | null} [options.position] where this device
 *   is, if it knows and is staying put. Read at each send until it answers,
 *   then sent once and not again.
 * @param {(state: Object) => void} [options.onChange] whenever the state moves
 * @param {"once"|"round"} [options.positionEvery] `once` for a device that
 *   stays put, `round` for one that moves — the first beat of every round
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
  position = () => null,
  positionEvery = "once",
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
  if (!Number.isInteger(beatsPerRound) || beatsPerRound < 0) {
    throw new Error("beatsPerRound is a whole number of beats, or 0 to only answer");
  }
  // A device that only answers has no round to fit anywhere, so the arithmetic
  // below does not apply to it.
  if (roundEveryMs != null && beatsPerRound > 0 && beatsPerRound * minuteMs + answerWindowMs >= roundEveryMs) {
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
  let positionSent = false;
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

  const send = (type, n, options) => {
    // Read at the send rather than at the start: a node's fix arrives when the
    // satellites allow, which is usually later than the page is ready.
    //
    // Two policies, because there are two kinds of device here. `once` is the
    // device that does not move: it has nothing to add by repeating itself,
    // and fifteen bytes on every beat for the length of a ride is a tax on a
    // carrier rationed by law. `round` is the one that does move — the first
    // beat of each round carries where it is, so the other end can keep the
    // ride too, at fifteen bytes a round rather than fifteen a beat. That
    // matters when the moving device is a phone on a bicycle, which is the
    // half most likely to run out of battery or link.
    const wanted = positionEvery === "round" ? type === "beat" && n === 1 : !positionSent;
    let pos = null;
    if (wanted) {
      try {
        pos = position();
      } catch {
        pos = null; // a fix nobody can read is a fix nobody sends
      }
      // Claimed here rather than in the acknowledgement below, which arrives a
      // microtask later: an echo and a beat started in the same tick would
      // both have read the flag as false and both have carried the position.
      if (pos && positionEvery !== "round") positionSent = true;
    }
    return courier.send(encodeHeartbeat({ type, tag, from: id, n, pos }), options).then(
      () => {
        sent[type === "beat" ? "beats" : "echoes"] += 1;
        lastError = null;
        changed();
      },
      (error) => {
        // A send that threw carried nothing, so the position has still not
        // been said. Releasing the claim is what stops an unconfigured node —
        // the commonest failure here — from losing it for the whole session.
        // Under `round` there is no claim to release: the next round asks
        // again on its own.
        if (pos && positionEvery !== "round") positionSent = false;
        lastError = error?.message ?? String(error);
        emit({ kind: "error", error });
        changed();
      },
    );
  };

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
    send("beat", beat, { rounds: 1 });
  };

  const startRound = () => {
    if (!running) return;
    // A stationary device answers and does not ask. It is still listening —
    // `start()` subscribed before this ran — so it echoes everything it hears;
    // it simply never opens a round of its own. In a range test that is the
    // whole difference between the two devices, and it halves the air.
    if (beatsPerRound === 0) return;
    rounds++;
    // No schedule means no next one. `nextRoundAt` stays null rather than
    // naming a time, because a screen that says "next at 14:20" when nothing
    // is coming is worse than one that says nothing.
    nextRoundAt = roundEveryMs == null ? null : timers.now() + roundEveryMs;
    if (roundEveryMs != null) roundTimer = timers.setTimeout(startRound, roundEveryMs);
    beat = 0;
    sendBeat();
  };

  const hear = (message, bytes) => {
    if (!sameTag(message.tag, tag)) return; // another list on the same channel
    const from = hex(message.from);
    if (from === self) return; // a link that hands a device its own frames back
    const at = timers.now();
    heard.set(from, at);
    lastHeardAt = at;
    received[message.type === "beat" ? "beats" : "echoes"] += 1;
    // `bytes` is what came off the carrier, `n` which beat it was. Both are
    // for the operator rather than the protocol: on a duty-cycled radio the
    // question is never only whether something arrived, but what it cost and
    // how many tries it took.
    emit({
      kind: "heard",
      type: message.type,
      from,
      n: message.n ?? null,
      bytes: bytes ?? null,
      // Where the answering device says it is, when it says so at all. Sent
      // once, so this is null on every message after the first.
      pos: message.pos ?? null,
    });

    if (message.type === "beat") {
      // Answered so the other device can stop looking, but only once per half
      // minute per device: a beat is cheap, an echo storm is not. An echo is
      // never answered, or two devices would answer each other forever.
      const last = echoedAt.get(from);
      if (last == null || at - last >= minuteMs / 2) {
        echoedAt.set(from, at);
        // The echo carries back the beat it answers, so the far side learns
        // which try got through rather than only that one did.
        emit({ kind: "echo", to: from, n: message.n ?? null });
        // The ARQ's default rounds: this device has demonstrably spoken.
        send("echo", message.n);
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
        if (message) hear(message, bytes?.length ?? null);
      });
      // Listening starts either way. Asking is what a schedule decides.
      if (roundEveryMs != null) startRound();
    },
    /**
     * Ask now, rather than at the next scheduled round.
     *
     * The one control a range test needs that a schedule cannot give: a rider
     * stops somewhere interesting and wants to know about *this* spot, not
     * about wherever the next round happens to fall. It also resets the clock,
     * so pressing it does not leave a round arriving seconds later.
     *
     * @returns {boolean} false when there was nothing to ask — a device that
     *   only answers, one that is stopped, or a round already in the air.
     */
    beatNow() {
      if (!running || beatsPerRound === 0 || beat > 0) return false;
      if (roundTimer) timers.clearTimeout(roundTimer);
      startRound();
      return true;
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
