// SPDX-License-Identifier: GPL-3.0-only
/**
 * Airtime estimation and duty-cycle pacing.
 *
 * The node's firmware is the legal enforcer — it refuses to transmit past the
 * regional budget. This module's job is different: pace our own traffic so the
 * firmware never has to refuse, because a paced protocol keeps working slowly
 * while an unpaced one fills the node's queue and reads legal throttling as
 * packet loss. See the duty-cycle comment on
 * https://github.com/NiKrause/funkpost/issues/1
 *
 * All numbers here are planning estimates; the hardware bench (plan step S5)
 * recalibrates them.
 */

/**
 * Nominal LoRa data rates per Meshtastic modem preset, bits per second, as
 * published in the Meshtastic docs. Estimates, not guarantees.
 */
export const PRESET_DATA_RATES_BPS = {
  SHORT_TURBO: 21880,
  SHORT_FAST: 10940,
  SHORT_SLOW: 6250,
  MEDIUM_FAST: 3520,
  MEDIUM_SLOW: 1950,
  LONG_FAST: 1070,
  LONG_MODERATE: 340,
  LONG_SLOW: 180,
};

/** Fixed per-packet overhead: preamble + sync, dominated by spreading factor. */
const PRESET_PREAMBLE_MS = {
  SHORT_TURBO: 10,
  SHORT_FAST: 15,
  SHORT_SLOW: 25,
  MEDIUM_FAST: 40,
  MEDIUM_SLOW: 70,
  LONG_FAST: 150,
  LONG_MODERATE: 300,
  LONG_SLOW: 500,
};

/** Mesh header bytes the radio sends around our payload. */
const PACKET_OVERHEAD_BYTES = 16;

/**
 * Rough on-air time for one packet carrying `byteLength` payload bytes.
 * @param {number} byteLength
 * @param {string} [preset]
 * @returns {number} milliseconds
 */
export function estimateAirtimeMs(byteLength, preset = "LONG_FAST") {
  const bps = PRESET_DATA_RATES_BPS[preset] || PRESET_DATA_RATES_BPS.LONG_FAST;
  const preambleMs = PRESET_PREAMBLE_MS[preset] || PRESET_PREAMBLE_MS.LONG_FAST;
  return preambleMs + ((byteLength + PACKET_OVERHEAD_BYTES) * 8 * 1000) / bps;
}

/**
 * A token bucket denominated in milliseconds of airtime.
 *
 * `take(costMs)` reserves the airtime immediately and returns how long the
 * caller must wait before transmitting — zero while budget remains, and the
 * shortfall paid from future refill once it is spent. Serialized sends
 * therefore drift to exactly the duty cycle, never above it.
 *
 * @param {Object} options
 * @param {number|null} options.dutyCycle Fraction (0.1 = 10 %); null = no limit
 * @param {number} [options.windowMs] Budget window, default one hour
 * @param {() => number} [options.now] Clock, injectable for tests
 */
export function createTokenBucket({ dutyCycle, windowMs = 3_600_000, now = Date.now } = {}) {
  if (dutyCycle == null || dutyCycle >= 1) {
    return {
      dutyCycle: null,
      take: () => 0,
      remainingMs: () => Number.POSITIVE_INFINITY,
    };
  }
  if (!(dutyCycle > 0)) throw new Error("dutyCycle must be a positive fraction or null");

  const capacityMs = dutyCycle * windowMs;
  let tokensMs = capacityMs;
  let lastRefill = now();

  const refill = () => {
    const at = now();
    tokensMs = Math.min(capacityMs, tokensMs + (at - lastRefill) * dutyCycle);
    lastRefill = at;
  };

  return {
    dutyCycle,
    /**
     * Reserve `costMs` of airtime. Returns the delay in ms before the
     * transmission may start (0 when budget is available now).
     */
    take(costMs) {
      refill();
      tokensMs -= costMs;
      if (tokensMs >= 0) return 0;
      return -tokensMs / dutyCycle;
    },
    /** Airtime still available right now, in ms (never negative). */
    remainingMs() {
      refill();
      return Math.max(0, tokensMs);
    },
  };
}
