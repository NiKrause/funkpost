// SPDX-License-Identifier: GPL-3.0-only
/**
 * The channel table, which four pages carried between 82 % and 100 %
 * identically — and which fails silently when it is wrong.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createChannelBook } from "../examples/radio/channels.js";

/** As the node reports them. */
const ch = (index, name, role = 2, psk = new Uint8Array([index])) => ({
  index,
  role,
  settings: { name, psk },
});

const book = (options = {}) => {
  const sent = [];
  const events = [];
  const b = createChannelBook({
    setTxChannel: (i) => sent.push(i),
    onEvent: (e) => events.push(e),
    ...options,
  });
  return { b, sent, events };
};

describe("the channel table", () => {
  test("keeps them in index order, with a fingerprint each", async () => {
    const { b } = book();
    await b.note(ch(3, "le-space.de"));
    await b.note(ch(0, "(default)", 1));
    assert.deepEqual(
      b.channels().map((c) => c.index),
      [0, 3],
      "the node reports them in whatever order it likes",
    );
    const [, lespace] = b.channels();
    assert.match(lespace.fingerprint, /^[0-9a-f]{4}$/, "two bytes, readable aloud");
    assert.equal(b.primary().name, "(default)", "role 1 is the node's own");
  });

  test("a name can lie about a key, so the fingerprint is the thing to compare", async () => {
    const { b } = book();
    await b.note(ch(1, "le-space.de", 2, new Uint8Array([1, 2, 3])));
    const { b: other } = book();
    await other.note(ch(1, "le-space.de", 2, new Uint8Array([9, 9, 9])));
    assert.notEqual(b.channels()[0].fingerprint, other.channels()[0].fingerprint);
  });

  test("a disabled channel is not a channel", async () => {
    // Offering it in a selector is offering silence.
    const { b } = book();
    assert.equal(await b.note(ch(2, "off", 0)), null);
    assert.equal(b.channels().length, 0);
  });

  test("moves onto the wanted channel by name, whenever it turns up", async () => {
    // They arrive one at a time and the wanted one need not be first.
    const { b, sent, events } = book({ preferred: "le-space.de" });
    await b.note(ch(0, "(default)", 1));
    assert.deepEqual(sent, [], "nothing to move onto yet");
    await b.note(ch(3, "le-space.de"));
    assert.deepEqual(sent, [3]);
    assert.equal(b.tx(), 3);
    assert.deepEqual(
      events.filter((e) => e.kind !== "channel").map((e) => e.kind),
      ["preferred", "changed"],
      "and it says the audience is different now",
    );
  });

  test("only ever moves off a channel nobody chose", async () => {
    const { b, sent } = book({ preferred: "le-space.de" });
    await b.note(ch(0, "(default)", 1));
    b.chooseByHand(0);
    await b.note(ch(3, "le-space.de"));
    assert.deepEqual(sent, [0], "the preference stays out of it from here on");
    assert.equal(b.tx(), 0);
    assert.ok(b.chosenByHand());
  });

  test("and it applies once, not on every channel after it", async () => {
    const { b, sent } = book({ preferred: "le-space.de" });
    await b.note(ch(3, "le-space.de"));
    await b.note(ch(4, "le-space.de"));
    assert.deepEqual(sent, [3]);
  });

  test("a page's broken log does not take the radio with it", async () => {
    const b = createChannelBook({
      onEvent: () => {
        throw new Error("the log is on fire");
      },
    });
    await assert.doesNotReject(b.note(ch(1, "x")));
    assert.equal(b.channels().length, 1);
  });
});

test("a page names the unnamed channel, because somebody reads it", async () => {
  const b = createChannelBook({ defaultName: "(Standard)" });
  await b.note({ index: 0, role: 1, settings: { psk: new Uint8Array([1]) } });
  assert.equal(b.channels()[0].name, "(Standard)");
});
