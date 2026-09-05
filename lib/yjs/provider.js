// SPDX-License-Identifier: GPL-3.0-only
/**
 * A Yjs provider over a byte courier — the second data plane.
 *
 * ## It is not tied to funkpost
 *
 * This provider talks to a **courier**, and a courier is any object with:
 *
 *     { send(bytes: Uint8Array): Promise<void>,
 *       onPayload(cb: (bytes: Uint8Array) => void): () => void }
 *
 * funkpost's Meshtastic courier is one such object, but nothing here knows
 * about LoRa, Meshtastic, framing or duty cycles. A WebSocket wrapper, a
 * BroadcastChannel, a serial line or your own transport works exactly as well
 * — which is the point: the sync protocol and the carrier are separable, and
 * this file is the proof on the Yjs side.
 *
 * ## The protocol, and why it is this small
 *
 * Two message types behind a one-byte tag:
 *
 *     [0] STATE_VECTOR  — "here is what I have"
 *     [1] UPDATE        — "here are some changes"
 *
 * A Yjs update is binary, compressed, commutative, associative and idempotent.
 * That last property is what makes this protocol so short: a duplicated,
 * reordered or replayed UPDATE is harmless, so the provider needs no sequence
 * numbers, no per-peer session state, and no handshake to tear down. It fits a
 * broadcast medium where "who is on the other side" is not a stable question.
 *
 * Convergence works like this. A peer publishes its state vector; anyone
 * holding entries that vector does not cover answers with exactly the missing
 * diff. A peer that *receives* a vector covering entries **it** lacks
 * publishes its own vector in reply, so the pull happens in both directions.
 * Once the two vectors cover each other neither condition fires and the
 * exchange goes quiet — no polling, no keepalive.
 *
 * ## What is deliberately absent
 *
 * **Awareness** (cursors, presence). It is designed for WebSocket cadence —
 * many small messages per second — which on a duty-cycled radio would spend
 * the entire airtime budget on "who is looking at this", starving the document
 * sync it is supposed to decorate. Message tag 2 is reserved for it should a
 * carrier ever justify it. See docs/yjs-provider.md.
 *
 * Requires `yjs` as a peer dependency (MIT). Nothing else — not y-protocols,
 * not lib0: the four core Yjs functions below are the whole vocabulary.
 */

import * as Y from "yjs";

/** "here is what I have" — an encoded Yjs state vector. */
export const MSG_STATE_VECTOR = 0;
/** "here are some changes" — an encoded Yjs update. */
export const MSG_UPDATE = 1;
/** Reserved for awareness. Deliberately unimplemented — see the note above. */
export const MSG_AWARENESS = 2;

const defaultTimers = {
  now: Date.now,
  setTimeout: (...args) => setTimeout(...args),
  clearTimeout: (...args) => clearTimeout(...args),
};

/**
 * Does `a` hold anything `b` has not seen? Compares decoded state vectors —
 * maps of clientId → clock, where the clock is how many operations by that
 * author the peer holds.
 */
const holdsMore = (a, b) => {
  for (const [client, clock] of a) {
    if (clock > (b.get(client) ?? 0)) return true;
  }
  return false;
};

/**
 * @param {Object} options
 * @param {Object} options.doc A `Y.Doc`
 * @param {{ send: Function, onPayload: Function }} options.courier Any byte
 *   courier — see the note at the top of this file
 * @param {number} [options.coalesceMs] Merge local edits arriving within this
 *   window into ONE payload (default 400). Typing fires a `doc.on("update")`
 *   per keystroke, and each payload is airtime; `Y.mergeUpdates` folds a burst
 *   into a single message. Set 0 to send every update immediately.
 * @param {number} [options.minAnnounceGapMs] Floor between *automatic* state
 *   vector publications (default 1000), so first contact between two peers who
 *   both announce cannot ping-pong. `resync()` ignores it.
 * @param {boolean} [options.announceOnStart] Publish a state vector on start
 *   (default true) — how a joiner asks for everything it is missing.
 * @param {Object} [options.timers] Injectable clock for tests
 * @param {(event: Object) => void} [options.onEvent] Instrumentation: sent /
 *   applied / coalesced / error events, for a sync pane or a bench
 * @returns {{ resync: Function, announce: Function, flush: Function,
 *   synced: Function, stats: Object, destroy: Function }}
 */
export function createYjsProvider({
  doc,
  courier,
  coalesceMs = 400,
  minAnnounceGapMs = 1000,
  announceOnStart = true,
  timers = defaultTimers,
  onEvent = null,
} = {}) {
  if (!doc || typeof doc.on !== "function") throw new Error("A Y.Doc is required");
  if (!courier || typeof courier.send !== "function" || typeof courier.onPayload !== "function") {
    throw new Error("A courier with send() and onPayload() is required");
  }

  // Tagging applied updates with this token is how a change that arrived from
  // the mesh is told apart from one the user just made — without it the
  // provider would echo every received update straight back onto the air.
  const remoteOrigin = { funkpost: "yjs-provider" };

  let destroyed = false;
  let pending = []; // local updates awaiting a flush
  let flushTimer = null;
  let lastAnnounceAt = null;

  const stats = {
    payloadsSent: 0,
    payloadsReceived: 0,
    updatesCoalesced: 0,
    bytesSent: 0,
    bytesReceived: 0,
  };

  const emit = (event) => {
    if (!onEvent) return;
    try {
      onEvent(event);
    } catch {
      // instrumentation must never break the provider
    }
  };

  const send = (type, body) => {
    const payload = new Uint8Array(1 + body.length);
    payload[0] = type;
    payload.set(body, 1);
    stats.payloadsSent++;
    stats.bytesSent += payload.length;
    emit({ kind: "sent", type, bytes: payload.length });
    // Delivery assurance belongs to the courier (and, above it, to the fact
    // that Yjs updates are idempotent — a re-send is always safe). A courier
    // that rejects must not become an unhandled rejection up here.
    return Promise.resolve(courier.send(payload)).catch((error) =>
      emit({ kind: "error", error }),
    );
  };

  /** Publish our state vector: "here is what I have; send me the rest." */
  const announce = ({ force = false } = {}) => {
    if (destroyed) return;
    const now = timers.now();
    if (!force && lastAnnounceAt != null && now - lastAnnounceAt < minAnnounceGapMs) return;
    lastAnnounceAt = now;
    send(MSG_STATE_VECTOR, Y.encodeStateVector(doc));
  };

  const flush = () => {
    if (flushTimer) {
      timers.clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (destroyed || pending.length === 0) return;
    const batch = pending;
    pending = [];
    // One payload for the whole burst — the difference between paying airtime
    // per keystroke and paying it per thought.
    const merged = batch.length === 1 ? batch[0] : Y.mergeUpdates(batch);
    if (batch.length > 1) {
      stats.updatesCoalesced += batch.length;
      emit({ kind: "coalesced", updates: batch.length, bytes: merged.length });
    }
    send(MSG_UPDATE, merged);
  };

  const onLocalUpdate = (update, origin) => {
    if (destroyed) return;
    if (origin === remoteOrigin) return; // arrived from the mesh — never echo it
    pending.push(update);
    if (coalesceMs <= 0) {
      flush();
      return;
    }
    if (flushTimer) return; // a flush is already scheduled for this burst
    flushTimer = timers.setTimeout(() => {
      flushTimer = null;
      flush();
    }, coalesceMs);
  };

  const handleStateVector = (body) => {
    let theirs;
    try {
      theirs = Y.decodeStateVector(body);
    } catch (error) {
      emit({ kind: "error", error });
      return;
    }
    const ours = Y.decodeStateVector(Y.encodeStateVector(doc));
    // They are missing something of ours: answer with exactly that diff.
    if (holdsMore(ours, theirs)) send(MSG_UPDATE, Y.encodeStateAsUpdate(doc, body));
    // We are missing something of theirs: publish our own vector so they
    // answer in turn. Rate-limited, so two fresh peers converge without a
    // ping-pong; once the vectors cover each other, neither branch fires.
    if (holdsMore(theirs, ours)) announce();
  };

  const handlePayload = (payload) => {
    if (destroyed || !payload || payload.length < 1) return;
    const type = payload[0];
    const body = payload.subarray(1);
    stats.payloadsReceived++;
    stats.bytesReceived += payload.length;

    if (type === MSG_UPDATE) {
      try {
        Y.applyUpdate(doc, body, remoteOrigin);
        emit({ kind: "applied", bytes: body.length });
      } catch (error) {
        emit({ kind: "error", error });
      }
      return;
    }
    if (type === MSG_STATE_VECTOR) {
      emit({ kind: "vector-rx", bytes: body.length });
      handleStateVector(body);
      return;
    }
    // Anything else — awareness one day, another protocol sharing this
    // courier today — is not ours. A shared channel is normal; stay quiet.
  };

  doc.on("update", onLocalUpdate);
  const unsubscribe = courier.onPayload(handlePayload);
  if (announceOnStart) announce({ force: true });

  return {
    /**
     * Publish our state vector unconditionally. Call it after a reconnect —
     * the peer re-answers with whatever the drop interrupted.
     */
    resync() {
      announce({ force: true });
    },

    /** Publish our state vector, honouring the automatic-announce floor. */
    announce() {
      announce();
    },

    /** Send any coalescing burst immediately instead of waiting out the timer. */
    flush,

    /**
     * True when this document holds everything `other` holds — the assertion a
     * convergence test wants. Takes a `Y.Doc` or an encoded state vector.
     */
    synced(other) {
      const theirs =
        other instanceof Uint8Array
          ? Y.decodeStateVector(other)
          : Y.decodeStateVector(Y.encodeStateVector(other));
      const ours = Y.decodeStateVector(Y.encodeStateVector(doc));
      return !holdsMore(theirs, ours);
    },

    stats,

    destroy() {
      if (destroyed) return;
      destroyed = true;
      if (flushTimer) timers.clearTimeout(flushTimer);
      flushTimer = null;
      pending = [];
      doc.off("update", onLocalUpdate);
      unsubscribe();
    },
  };
}
