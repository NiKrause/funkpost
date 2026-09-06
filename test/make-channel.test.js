import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

const run = (args) =>
  execFileSync("node", ["scripts/make-channel.js", ...args, "--no-qr"], { encoding: "utf8" });

test("the same key regenerates the same channel", () => {
  const psk = "6242c72b4ea743c4dbcd530bd175a36034a26d721e21fd97237b06d2c6e0eacc";
  const url = (out) => out.match(/https:\S+/)[0];
  assert.equal(url(run(["--name", "bench", "--psk", psk])), url(run(["--name", "bench", "--psk", psk])));
});

test("two fresh channels never share a key", () => {
  const key = (out) => out.match(/key:\s+([0-9a-f]{32,})/)[1];
  assert.notEqual(key(run(["--name", "a"])), key(run(["--name", "b"])));
});

test("a channel set keeps the order it was given", () => {
  // Order is not cosmetic: the firmware makes the first entry index 0, and
  // with channel_num at 0 the frequency slot is derived from *that* channel's
  // name. A set that reorders silently moves the radio.
  const out = run([
    "--slot", "default",
    "--slot", "local-mesh:aabbccddeeff00112233445566778899",
    "--slot", "le-space.de:5e08894adc2b00307796581213bbd9072bc1beaad48212d5a17873461d3e83fd",
  ]);
  const lines = out.split("\n").filter((l) => /^\s+\d\s/.test(l));
  assert.match(lines[0], /^\s+0\s+\(default/);
  assert.match(lines[0], /primary$/);
  assert.match(lines[1], /^\s+1\s+local-mesh/);
  assert.match(lines[2], /^\s+2\s+le-space\.de/);
  assert.match(lines[2], /secondary$/);
  // The published channel's fingerprint is a fixed value — if the key ever
  // changed, every device carrying it would go silent, so it is pinned here.
  assert.match(lines[2], /⌗3dd3/);
});

test("a set says where the frequency comes from", () => {
  const derived = run(["--slot", "le-space.de:01", "--slot", "b"]);
  assert.match(derived, /frequency\s+derived from »le-space\.de« at index 0/);
  const pinned = run(["--slot", "default", "--channel-num", "20"]);
  assert.match(pinned, /frequency\s+slot 20, pinned/);
});

test("--slot and the single-channel options are not mixed", () => {
  // They describe the same thing two ways, and silently honouring one would
  // hand back a set the caller did not ask for.
  assert.throws(
    () => run(["--slot", "a", "--name", "b"]),
    (e) => /--slot builds the whole set/.test(e.stderr ?? ""),
  );
});

test("--default rebuilds the public channel byte for byte", () => {
  // The canonical default link is `#CgMSAQE`: an empty name, so the preset
  // supplies "LongFast", and a one-byte psk of 0x01 meaning the well-known key.
  // Ours must start with exactly those bytes and only add the LoRa config —
  // otherwise it is a different channel on a different frequency slot, and
  // whoever ran it to recover would be alone on the air without being told.
  const fragment = run(["--default"]).match(/#(\S+)/)[1];
  assert.ok(fragment.startsWith("CgMSAQE"), fragment);
});

test("--default refuses a preset that would make it another channel", () => {
  assert.throws(
    () => run(["--default", "--preset", "SHORT_TURBO"]),
    (e) => /would be another channel/.test(e.stderr ?? ""),
  );
});

test("refuses what the firmware would refuse", () => {
  for (const [args, expected] of [
    [["--name", "much-too-long-a-name"], /1–11 bytes/],
    [["--region", "MARS"], /unknown region/],
    [["--preset", "TURBO_MAX"], /unknown modem preset/],
    [["--psk", "abcd"], /16 or 32 bytes/],
  ]) {
    assert.throws(() => run(args), (e) => expected.test(e.stderr ?? ""), args.join(" "));
  }
});
