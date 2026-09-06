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
  const key = (out) => out.match(/key\s+([0-9a-f]+)/)[1];
  assert.notEqual(key(run(["--name", "a"])), key(run(["--name", "b"])));
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
