// SPDX-License-Identifier: GPL-3.0-only
/**
 * Which node is this, in the words its owner can check against the device.
 *
 * "Connected" is not an answer in a room with two radios in it. A Meshtastic
 * node shows four characters on its own screen, and that is the thing somebody
 * can read off the hardware and compare — so that is what the page has to say.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { nodeIdentity } from "../examples/radio/connect.js";

// The example from the field: a node whose display reads C45E.
const NUM = 0xa1b2c45e;

describe("naming the node this page is talking to", () => {
  test("the id is the number in hex, the way every other Meshtastic tool prints it", () => {
    assert.equal(nodeIdentity(NUM).id, "!a1b2c45e");
    // Leading zeros are part of it: !00abcdef is eight digits, not six.
    assert.equal(nodeIdentity(0x00abcdef).id, "!00abcdef");
  });

  test("a node with no short name set shows the last four of its id, as the device does", () => {
    assert.equal(nodeIdentity(NUM).shortName, "C45E");
    assert.equal(nodeIdentity(NUM, {}).shortName, "C45E");
    assert.equal(nodeIdentity(NUM, { shortName: "   " }).shortName, "C45E", "whitespace is not a name");
  });

  test("a short name somebody set wins, because that is what the display shows", () => {
    assert.equal(nodeIdentity(NUM, { shortName: "WALD" }).shortName, "WALD");
    assert.equal(nodeIdentity(NUM, { shortName: " WALD " }).shortName, "WALD");
  });

  test("the long name comes along when there is one, and is empty when there is not", () => {
    assert.equal(nodeIdentity(NUM, { longName: "Nicos Knoten" }).longName, "Nicos Knoten");
    assert.equal(nodeIdentity(NUM).longName, "");
  });

  test("no number is no identity, rather than a node called !00000000", () => {
    assert.equal(nodeIdentity(null), null);
    assert.equal(nodeIdentity(undefined), null);
    assert.equal(nodeIdentity(Number.NaN), null);
    // Zero is not a node number, but it is a finite one; it must not become
    // the id of whatever page happens to be connected to nothing.
    assert.equal(nodeIdentity(0).id, "!00000000");
  });

  test("a number past 2^31 reads the same whichever sign it arrives with", () => {
    // Node numbers are unsigned 32-bit and routinely sit above 2^31. Coming
    // through protobuf they are positive; coming through anything that did a
    // bitwise operation on the way they are the same bits, negative. Both have
    // to print the id that is written on the device.
    assert.equal(nodeIdentity(0xfedcba98).id, "!fedcba98");
    assert.equal(nodeIdentity(0xfedcba98).shortName, "BA98");
    assert.equal(nodeIdentity(-19088744).id, "!fedcba98", "the same node, signed");
    assert.equal(nodeIdentity(-19088744).shortName, "BA98");
  });
});
