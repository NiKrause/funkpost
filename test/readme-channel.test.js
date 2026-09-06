// SPDX-License-Identifier: GPL-3.0-only
/**
 * The published test channel appears in the README twice — as a QR image and as
 * a key with a fingerprint in a table — and they must be the same channel.
 *
 * They can drift silently, which is the whole problem: a wrong channel does not
 * error, it produces a radio that hears nothing, and nobody reading the page can
 * tell by looking. An image is worse than text for this, because it cannot be
 * proofread at all.
 *
 * There is no URL in the README any more — a channel link is only meaningful to
 * the Meshtastic app, so the code is the thing to scan and the link was just an
 * invitation to click. The URL is rebuilt here from the published key, which
 * makes this check tighter than it was: it ties the *image* to the *key*, with
 * nothing in between to drift.
 *
 * What it does NOT prove is that a device accepts the link. Only a device can
 * say that.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";

const root = new URL("../", import.meta.url);
const README = readFileSync(new URL("README.md", root), "utf8");

const key = README.match(/\b[0-9a-f]{64}\b/)?.[0];
const fingerprint = README.match(/⌗([0-9a-f]{4})/)?.[1];
const name = README.match(/`(le-space\.de)`/)?.[1];

test("the README publishes a key, a fingerprint and a channel name", () => {
  assert.ok(key, "no 32-byte key in the README");
  assert.ok(fingerprint, "no fingerprint in the README");
  assert.ok(name, "no channel name in the README");
});

test("the fingerprint is this key's", () => {
  // The fingerprint is what people compare across devices, so a stale one sends
  // somebody hunting for a mismatch that is only in the documentation.
  assert.equal(
    crypto.createHash("sha256").update(Buffer.from(key, "hex")).digest("hex").slice(0, 4),
    fingerprint,
  );
});

test("the QR image is the channel the README publishes", (t) => {
  // qrencode is how the image was made; without it there is nothing to compare
  // against, and a skipped check is honest where a silent pass is not.
  try {
    execFileSync("qrencode", ["--version"], { stdio: "ignore" });
  } catch {
    t.skip("qrencode is not installed");
    return;
  }

  const url = execFileSync(
    "node",
    ["scripts/make-channel.js", "--name", name, "--psk", key, "--no-qr"],
    { encoding: "utf8", cwd: new URL(".", root).pathname },
  ).match(/https:\/\/\S+/)[0];

  const regenerated = execFileSync(
    "qrencode",
    ["-t", "SVG", "--svg-path", "--rle", "-m", "2", "-s", "4",
     "--background=FFFFFF", "--foreground=000000", "-o", "-", url],
    { encoding: "utf8" },
  );
  const shipped = readFileSync(new URL("docs/img/channel-le-space.svg", root), "utf8");
  assert.equal(regenerated, shipped, "the QR in the README is not this key's channel");
});
