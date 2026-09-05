// SPDX-License-Identifier: GPL-3.0-only
/**
 * The byte courier: reliable-enough delivery of arbitrary payloads over a
 * lossy, tiny-MTU, airtime-budgeted mesh link.
 *
 * Implements the seam contract from orbitdb-storacha-bridge/courier-sync
 * (issue #50 there): `send(bytes)` resolves when the payload is delivered —
 * and may be slow on purpose, because pacing to the regional duty cycle is
 * this layer's job (issue #1 here). `onPayload(cb)` delivers reassembled
 * payloads exactly once per message id.
 *
 * Mechanics per message: fragment (framing.js) → transmit paced (pacing.js)
 * → receiver reassembles and answers with a STATUS bitmap (on the last
 * fragment of a wave, on a gap timeout, and on any fragment of an
 * already-completed message, which is a lost-ACK repair) → sender retransmits
 * exactly the missing fragments → bounded rounds, then the send rejects.
 *
 * The link underneath is anything with:
 *   { mtu: number, send(bytes): Promise<void>, onFrame(cb): unsubscribe }
 * — the real one wraps a Meshtastic MeshDevice (links/meshtastic-device-link.js),
 * the test one is an in-memory mesh (links/memory-mesh.js).
 */

import { fragmentPayload, encodeStatus, decodeFrame, createReassembler } from "./framing.js";
import { createTokenBucket, estimateAirtimeMs } from "./pacing.js";
import { regionPolicy } from "./regions.js";

const defaultTimers = {
  now: Date.now,
  setTimeout: (...args) => setTimeout(...args),
  clearTimeout: (...args) => clearTimeout(...args),
};

/**
 * @param {Object} options
 * @param {{ mtu: number, send: Function, onFrame: Function, close?: Function }} options.link
 * @param {string|{ dutyCycle: number|null }} [options.region] Firmware region
 *   name (pacing follows lib/regions.js) or an explicit `{ dutyCycle }`.
 * @param {string} [options.preset] Modem preset, for airtime estimates
 * @param {number} [options.maxRounds] Transmission rounds before a send rejects
 * @param {number} [options.rtoMs] Retransmit timeout override (default derives
 *   from the airtime estimate)
 * @param {number} [options.gapMs] Receiver quiet-time before an unsolicited STATUS
 * @param {number} [options.windowMs] Token-bucket window (default one hour)
 * @param {boolean} [options.allowMisconfigured] Permit transmitting through a
 *   node whose region is UNSET/unknown (default false — see issue #1)
 * @param {Object} [options.timers] Injectable clock for tests
 * @param {(event: Object) => void} [options.onEvent] Instrumentation hook (the
 *   demo's sync pane): frame-tx / frame-rx / delivered / giveup / error events
 */
export function createMeshtasticCourier({
  link,
  region = "UNSET",
  preset = "LONG_FAST",
  maxRounds = 8,
  rtoMs = null,
  gapMs = null,
  minFrameGapMs = 0,
  windowMs = undefined,
  allowMisconfigured = false,
  timers = defaultTimers,
  onEvent = null,
} = {}) {
  if (!link || typeof link.send !== "function" || typeof link.onFrame !== "function") {
    throw new Error("A link with send() and onFrame() is required");
  }

  const resolvePolicy = (r) =>
    typeof r === "object" && r !== null
      ? { region: r.region || "custom", dutyCycle: r.dutyCycle ?? null, misconfigured: false }
      : regionPolicy(r);

  // Region and its bucket are mutable: a node that boots slowly (or has just
  // rebooted to apply a channel import) reports its region late, and the
  // courier must adopt it when it arrives instead of being frozen at the
  // value seen at connect time. See setRegion.
  let policy = resolvePolicy(region);
  let modemPreset = preset;
  let bucket = createTokenBucket({
    dutyCycle: policy.dutyCycle,
    windowMs,
    now: timers.now,
  });
  const reassembler = createReassembler({ now: timers.now });

  const inflight = new Map(); // msgId -> sender state
  const gapTimers = new Map(); // msgId -> receiver gap timer
  const payloadCbs = new Set();
  const stats = {
    framesTx: 0,
    framesRx: 0,
    airtimeSpentMs: 0,
    payloadsSent: 0,
    payloadsDelivered: 0,
    retransmitRounds: 0,
  };
  let closed = false;
  let lastFrameSentAt = null; // timers.now() of the last on-air frame, for minFrameGapMs

  const emit = (event) => {
    if (!onEvent) return;
    try {
      onEvent(event);
    } catch {
      // instrumentation must not break the courier
    }
  };

  const sleep = (ms) => new Promise((resolve) => timers.setTimeout(resolve, ms));

  const defaultRto = (fragments) =>
    2 * (fragments + 1) * estimateAirtimeMs(link.mtu, modemPreset) + 500;
  const defaultGap = () => 3 * estimateAirtimeMs(link.mtu, modemPreset) + 250;

  /**
   * Pace one frame through the airtime budget, then hand it to the link.
   *
   * @returns {Promise<boolean>} whether it actually went on the air. False
   *   means the radio deferred it under the duty cycle — the frame is still
   *   outstanding and this must not be counted as a delivery attempt.
   */
  const transmitFrame = async (frame) => {
    const airtimeMs = estimateAirtimeMs(frame.length, modemPreset);
    // Two independent reasons to wait before a frame: the airtime budget (the
    // token bucket — only bites when the duty cycle is nearly spent), and a
    // minimum inter-frame gap. The gap matters when the budget is NOT the
    // constraint: with plenty of airtime the bucket returns 0 for every
    // fragment, so a multi-fragment payload would burst back-to-back and
    // flood a phone's BLE write path — which drops the GATT link mid-send
    // (the blocks-send disconnect seen on hardware). The gap paces the writes
    // regardless of budget.
    const budgetWait = bucket.take(airtimeMs);
    const gapWait =
      lastFrameSentAt == null ? 0 : Math.max(0, minFrameGapMs - (timers.now() - lastFrameSentAt));
    const waitMs = Math.max(budgetWait, gapWait);
    if (waitMs > 0) await sleep(waitMs);
    if (closed) return;
    try {
      await link.send(frame);
    } catch (error) {
      if (error?.dutyCycleExhausted) {
        // The firmware is the authority on its own airtime, and it just said
        // our budget was fiction — it counts beacons, telemetry and relaying,
        // which no local model sees. Empty the bucket so pacing backs off, and
        // leave the frame outstanding: the retransmit timer will try again
        // once the hour has moved on. Dropping it here would throw away a
        // payload over a limit that expires by itself.
        if (bucket.setRemainingMs) bucket.setRemainingMs(0);
        emit({ kind: "duty-cycle-exhausted" });
        return false;
      }
      throw error;
    }
    lastFrameSentAt = timers.now();
    stats.framesTx++;
    stats.airtimeSpentMs += airtimeMs;
    emit({ kind: "frame-tx", bytes: frame.length, airtimeMs, waitedMs: waitMs });
    return true;
  };

  const settle = (state, error) => {
    if (state.settled) return;
    state.settled = true;
    if (error) state.reject(error);
    else state.resolve();
  };

  const finishSend = (msgId, state, error) => {
    if (state.done) return;
    state.done = true;
    if (state.rtoTimer) timers.clearTimeout(state.rtoTimer);
    inflight.delete(msgId);
    if (error) {
      emit({ kind: "giveup", msgId, rounds: state.rounds, reason: error?.message });
      // A fire-and-forget send has already resolved on transmission; only an
      // awaited delivery (or a failure before the first wave went out)
      // surfaces as a rejection.
      settle(state, error);
    } else {
      emit({ kind: "delivered", msgId, rounds: state.rounds });
      settle(state, null);
    }
  };

  const transmitWave = async (msgId, state) => {
    if (state.done || state.sending) return;
    const limit = state.maxRounds ?? maxRounds;
    state.rounds++;
    if (state.rounds > limit) {
      finishSend(msgId, state, new Error(`message ${msgId} undelivered after ${limit} rounds`));
      return;
    }
    if (state.rounds > 1) stats.retransmitRounds++;
    state.sending = true;
    let deferred = 0;
    let transmitted = 0;
    try {
      for (const idx of [...state.outstanding]) {
        if (state.done) return;
        if (!state.outstanding.has(idx)) continue; // acked mid-wave
        // eslint-disable-next-line no-await-in-loop
        if (await transmitFrame(state.frames[idx])) transmitted++;
        else deferred++;
      }
    } finally {
      state.sending = false;
    }
    // A wave the radio refused on airtime grounds is not an attempt — nothing
    // was tried, so nothing can have failed. Counting it would let the ARQ
    // exhaust its rounds while waiting for a budget that recovers more slowly
    // than the retransmit timer ticks, and drop the payload over a limit that
    // expires by itself.
    if (transmitted === 0 && deferred > 0) state.rounds--;
    if (state.done) return;
    if (state.outstanding.size === 0) {
      finishSend(msgId, state, null);
      return;
    }
    if (state.rtoTimer) timers.clearTimeout(state.rtoTimer);
    state.rtoTimer = timers.setTimeout(
      () => void transmitWave(msgId, state).catch((error) => finishSend(msgId, state, error)),
      rtoMs ?? defaultRto(state.outstanding.size),
    );
  };

  const sendStatus = (msgId, total, received) => {
    transmitFrame(encodeStatus(msgId, total, received)).catch((error) =>
      emit({ kind: "error", error }),
    );
  };

  const clearGapTimer = (msgId) => {
    const timer = gapTimers.get(msgId);
    if (timer) {
      timers.clearTimeout(timer);
      gapTimers.delete(msgId);
    }
  };

  const handleData = (frame) => {
    const result = reassembler.push(frame);
    if (result.kind === "complete") {
      clearGapTimer(frame.msgId);
      stats.payloadsDelivered++;
      emit({ kind: "payload-rx", msgId: frame.msgId, bytes: result.payload.length });
      const all = new Set(Array.from({ length: result.total }, (_, i) => i));
      sendStatus(frame.msgId, result.total, all);
      for (const cb of payloadCbs) {
        try {
          cb(result.payload);
        } catch (error) {
          emit({ kind: "error", error });
        }
      }
      return;
    }
    if (result.kind === "duplicate-complete") {
      // Our earlier STATUS was lost; repeat the acknowledgement.
      const all = new Set(Array.from({ length: result.total }, (_, i) => i));
      sendStatus(frame.msgId, result.total, all);
      return;
    }
    // Partial: answer at the end of the sender's wave, or after a quiet gap.
    if (frame.idx === frame.total - 1) {
      clearGapTimer(frame.msgId);
      sendStatus(frame.msgId, result.total, result.received);
      return;
    }
    clearGapTimer(frame.msgId);
    gapTimers.set(
      frame.msgId,
      timers.setTimeout(() => {
        gapTimers.delete(frame.msgId);
        const progress = reassembler.received(frame.msgId);
        if (progress) sendStatus(frame.msgId, progress.total, progress.received);
      }, gapMs ?? defaultGap()),
    );
  };

  const handleStatus = (frame) => {
    const state = inflight.get(frame.msgId);
    if (!state || state.done) return; // a late acknowledgement
    for (const idx of frame.received) state.outstanding.delete(idx);
    if (state.outstanding.size === 0) {
      finishSend(frame.msgId, state, null);
      return;
    }
    // The receiver named the gaps; retransmit them now instead of waiting.
    if (!state.sending) {
      if (state.rtoTimer) timers.clearTimeout(state.rtoTimer);
      void transmitWave(frame.msgId, state).catch((error) =>
        finishSend(frame.msgId, state, error),
      );
    }
  };

  const unsubscribe = link.onFrame((bytes) => {
    if (closed) return;
    stats.framesRx++;
    const frame = decodeFrame(bytes);
    if (!frame) return; // other traffic on a shared channel
    emit({ kind: "frame-rx", type: frame.type, bytes: bytes.length });
    try {
      if (frame.type === "data") handleData(frame);
      else handleStatus(frame);
    } catch (error) {
      emit({ kind: "error", error });
    }
  });

  return {
    /**
     * Send one payload to the peer.
     *
     * By default this resolves once the first wave of fragments has been
     * transmitted within the airtime budget — the "or scheduled" half of the
     * seam contract. A broadcast into an empty room must not hang on an
     * acknowledgement nobody can give; delivery assurance stays with the ARQ
     * (STATUS-driven retransmits keep running in the background, ending in a
     * `delivered` or `giveup` event) and with the protocol above (re-announce
     * heals what the radio lost).
     *
     * Pass `awaitDelivery: true` to get the strict form: resolves only when
     * the receiver has acknowledged every fragment, rejects after `maxRounds`
     * transmission rounds. The bench uses it to measure true delivery time.
     *
     * Pass `rounds: 1` for a payload nobody is expected to acknowledge — a
     * broadcast greeting into a room that may be empty. The ARQ cannot help
     * there: with no STATUS coming back it simply retransmits to exhaustion,
     * paying the full airtime for a message whose whole point is that it will
     * be repeated later anyway. Answers to a peer who has demonstrably spoken
     * should keep the default.
     */
    async send(payload, { awaitDelivery = false, rounds = maxRounds } = {}) {
      if (closed) throw new Error("courier is closed");
      if (policy.misconfigured && !allowMisconfigured) {
        throw new Error(
          "node region is UNSET/unknown — refusing to transmit (set the region, or pass allowMisconfigured)",
        );
      }
      const { msgId, frames } = fragmentPayload(payload, { mtu: link.mtu });
      stats.payloadsSent++;
      return new Promise((resolve, reject) => {
        const state = {
          frames,
          maxRounds: rounds,
          outstanding: new Set(frames.keys()),
          rounds: 0,
          sending: false,
          done: false,
          settled: false,
          rtoTimer: null,
          resolve,
          reject,
        };
        inflight.set(msgId, state);
        transmitWave(msgId, state)
          .then(() => {
            if (!awaitDelivery) settle(state, null);
          })
          .catch((error) => finishSend(msgId, state, error));
      });
    },

    onPayload(cb) {
      payloadCbs.add(cb);
      return () => payloadCbs.delete(cb);
    },

    /**
     * Correct the pacing budget with the node's own measured airtime
     * utilisation (air_util_tx: percent of the last hour spent transmitting).
     * The device counts ALL of its transmissions — beacons, telemetry,
     * relaying for the mesh — which the local estimate cannot see; the duty
     * cycle binds the device, so the device's number wins. Survives page
     * reloads and multiple clients for free, because the node is the store.
     */
    reconcileNodeAirtime(utilPercent) {
      if (policy.dutyCycle == null || !bucket.setRemainingMs) return;
      if (typeof utilPercent !== "number" || Number.isNaN(utilPercent)) return;
      const HOUR_MS = 3_600_000;
      const spentMs = (utilPercent / 100) * HOUR_MS;
      bucket.setRemainingMs(policy.dutyCycle * HOUR_MS - spentMs);
    },

    /**
     * Adopt a region reported after construction — the node telling us where
     * it stands once its config stream catches up (a slow or freshly rebooted
     * node reports it late). Rebuilds the pacing policy and bucket; a
     * following reconcileNodeAirtime re-corrects the budget from the device's
     * own accounting. An unchanged region is a no-op.
     */
    /**
     * Adopt the modem preset the node reports. Pacing and every airtime figure
     * key off it, and the spread between presets is twentyfold — so guessing
     * is not a small error, it is the whole measurement.
     */
    setPreset(next) {
      if (typeof next === "string" && next.length > 0) modemPreset = next;
    },

    setRegion(nextRegion) {
      const next = resolvePolicy(nextRegion);
      if (next.region === policy.region && next.dutyCycle === policy.dutyCycle) return;
      policy = next;
      bucket = createTokenBucket({ dutyCycle: policy.dutyCycle, windowMs, now: timers.now });
    },

    /** The law clause of the seam: what may still go on the air right now. */
    budget() {
      return {
        region: policy.region,
        preset: modemPreset,
        dutyCycle: policy.dutyCycle,
        misconfigured: policy.misconfigured,
        remainingAirtimeMs: bucket.remainingMs(),
      };
    },

    stats,

    close() {
      if (closed) return;
      closed = true;
      unsubscribe();
      for (const [msgId, state] of inflight) {
        finishSend(msgId, state, new Error("courier closed"));
      }
      for (const msgId of gapTimers.keys()) clearGapTimer(msgId);
      if (link.close) link.close();
    },
  };
}
