// SPDX-License-Identifier: GPL-3.0-only
/**
 * Which channel should an app transmit on?
 *
 * A channel *index* is per-device bookkeeping: the same imported channel may
 * sit at 1 on one node and 3 on another, depending on what each device already
 * had. Two apps that both default to index 0 will therefore transmit to
 * different rooms while showing the same channel name to their users — and the
 * failure is silent, because a node drops what it cannot decrypt without
 * telling anyone (docs/channels.md).
 *
 * So the agreement is made on the **name**, which is the part both devices
 * actually share, and each side looks up its own index.
 *
 * This lives in the library rather than in either demo because the whole point
 * is that two *different* applications land on the same channel. Two copies of
 * this rule would be two chances to drift.
 */

/** The channel the demos look for. Published, with a QR, in the README. */
export const DEFAULT_PREFERRED_CHANNEL = "le-space.de";

/**
 * The index to transmit on, or `null` to leave the current choice alone.
 *
 * `channels` are `{ index, name }` records as they arrive from the node.
 * Matching is exact after trimming: Meshtastic names are bytes, and two
 * channels differing only in case are two different channels with two
 * different keys, so a lenient match here would produce exactly the silent
 * mismatch this exists to prevent.
 */
export function preferredChannelIndex(channels, name = DEFAULT_PREFERRED_CHANNEL) {
  const wanted = (name ?? "").trim();
  if (!wanted) return null;
  const match = (channels ?? []).find((c) => (c?.name ?? "").trim() === wanted);
  // A channel can legitimately be at index 0, so `null` is the only safe
  // "nothing found" — `match?.index` would report 0 as absent.
  return match ? match.index : null;
}
