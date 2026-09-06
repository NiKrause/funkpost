// SPDX-License-Identifier: GPL-3.0-only
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  preferredChannelIndex,
  DEFAULT_PREFERRED_CHANNEL,
} from "../lib/links/channel-preference.js";

const channels = [
  { index: 0, name: "(default)" },
  { index: 1, name: "ROTTAL-MESH" },
  { index: 3, name: "le-space.de" },
];

test("finds the channel by name, not by position", () => {
  assert.equal(preferredChannelIndex(channels, "le-space.de"), 3);
  assert.equal(preferredChannelIndex(channels, DEFAULT_PREFERRED_CHANNEL), 3);
});

test("index 0 is a real answer, not a missing one", () => {
  // `match?.index` would report this as absent, and the app would stay on
  // whatever it had — the exact bug this function exists to avoid.
  assert.equal(preferredChannelIndex([{ index: 0, name: "le-space.de" }]), 0);
});

test("leaves the choice alone when the node does not have the channel", () => {
  assert.equal(preferredChannelIndex(channels, "not-here"), null);
  assert.equal(preferredChannelIndex([], "le-space.de"), null);
  assert.equal(preferredChannelIndex(undefined), null);
});

test("an empty preference switches the preference off", () => {
  // `?channel=` in the URL: someone who wants the node's own default back.
  assert.equal(preferredChannelIndex(channels, ""), null);
  assert.equal(preferredChannelIndex(channels, null), null);
});

test("matching is exact, because a near-match is a different key", () => {
  // Two channels differing only in case are two channels with two different
  // keys. Matching leniently would produce a confident, silent mismatch —
  // both sides transmitting, neither able to decrypt (docs/channels.md).
  assert.equal(preferredChannelIndex(channels, "LE-SPACE.DE"), null);
  assert.equal(preferredChannelIndex(channels, "le-space"), null);
  // Trimmed, though: a stray space in a URL parameter is a typo, not a choice.
  assert.equal(preferredChannelIndex(channels, "  le-space.de "), 3);
});
