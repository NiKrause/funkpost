// SPDX-License-Identifier: GPL-3.0-only
/**
 * The channel table, and the one thing every demo does with it.
 *
 * Four pages had this, between 82 % and 100 % identical line for line —
 * measured, not guessed, which is why this is the first thing out of them
 * (#194). It is also the path that fails *silently* when it is wrong: two
 * radios on different channels behave exactly like two radios out of range, so
 * four copies of it is four places for the same silence to come from.
 *
 * What it knows:
 *
 * - the channels the node has reported, in index order, each with a
 *   **fingerprint** — two bytes of SHA-256 over the key — because a channel
 *   can carry a familiar name and a completely different key, and the name
 *   will not tell you;
 * - which one to transmit on, preferring a **name** rather than an index: the
 *   index is per device, so a name is the only thing two operators can agree
 *   on without comparing numbers at a kerb;
 * - and that it must never move off a channel somebody chose by hand.
 *
 * Plain JavaScript and no framework, like the rest of this package: what has
 * bugs here is the bookkeeping, not the rendering.
 */
import { preferredChannelIndex, DEFAULT_PREFERRED_CHANNEL } from "@le-space/funkpost";

/** Two bytes of the key's digest — short enough to read out, long enough to differ. */
async function fingerprint(psk, subtle = globalThis.crypto?.subtle) {
  if (!subtle) return "";
  const digest = new Uint8Array(await subtle.digest("SHA-256", psk ?? new Uint8Array()));
  return [...digest.slice(0, 2)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * @param {Object} [options]
 * @param {string} [options.preferred] channel name to move onto, by name
 * @param {string} [options.defaultName] what to call a channel the node left
 *   unnamed — a page's own word, because it is shown to somebody
 * @param {(index: number) => void} [options.setTxChannel] tell the radio
 * @param {(event: Object) => void} [options.onEvent] `channel` (one reported),
 *   `preferred` (moved on its own), `chosen` (by hand), `changed` (the
 *   audience is different now, so whatever was heard is no longer evidence)
 */
export function createChannelBook({
  preferred = DEFAULT_PREFERRED_CHANNEL,
  defaultName = "(default)",
  setTxChannel = () => {},
  onEvent = () => {},
  subtle = globalThis.crypto?.subtle,
} = {}) {
  const book = new Map();
  let chosenByHand = false;
  let preferenceApplied = false;
  let tx = 0;
  let primary = null;

  const list = () => [...book.values()].sort((a, b) => a.index - b.index);

  const emit = (event) => {
    try {
      onEvent(event);
    } catch {
      // A page's own log must not take the radio down with it.
    }
  };

  /** Only ever moves off a channel nobody chose. */
  function applyPreferred() {
    if (preferenceApplied || chosenByHand) return false;
    const index = preferredChannelIndex(list(), preferred);
    if (index == null) return false;
    preferenceApplied = true;
    tx = index;
    setTxChannel(index);
    const entry = book.get(index) ?? null;
    emit({ kind: "preferred", index, channel: entry });
    emit({ kind: "changed", index, channel: entry });
    return true;
  }

  return {
    /**
     * The node reported a channel. They arrive one at a time and the wanted
     * one need not be first, so the preference is retried on every one.
     *
     * A disabled channel is not a channel: it cannot be transmitted on and
     * offering it in a selector is offering silence.
     */
    async note(channel) {
      if (!channel || channel.role === 0) return null;
      const entry = {
        index: channel.index,
        role: channel.role,
        name: channel.settings?.name || defaultName,
        fingerprint: await fingerprint(channel.settings?.psk, subtle),
      };
      book.set(entry.index, entry);
      if (entry.role === 1) primary = { name: entry.name, fingerprint: entry.fingerprint };
      emit({ kind: "channel", channel: entry });
      applyPreferred();
      return entry;
    },

    /**
     * Somebody picked one. From here on the preference stays out of it — a
     * page that moved itself off a hand-picked channel would be overruling the
     * operator at the worst possible moment.
     */
    chooseByHand(index) {
      chosenByHand = true;
      tx = index;
      setTxChannel(index);
      const entry = book.get(index) ?? null;
      emit({ kind: "chosen", index, channel: entry });
      emit({ kind: "changed", index, channel: entry });
      return entry;
    },

    channels: () => list(),
    /** The index being transmitted on. */
    tx: () => tx,
    /** The node's primary channel, which is the one its name is usually about. */
    primary: () => primary,
    chosenByHand: () => chosenByHand,
  };
}
