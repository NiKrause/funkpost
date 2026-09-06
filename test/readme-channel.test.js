// SPDX-License-Identifier: GPL-3.0-only
/**
 * The published test channel appears in the README three times — as a QR
 * image, as a URL, and as a key in a table — and they must all be the same
 * channel.
 *
 * They can drift silently, which is the whole problem: a wrong channel does not
 * error, it produces a radio that hears nothing, and nobody reading the README
 * can tell by looking. This file exists because the URL was once moved from a
 * markdown link into a code fence without anyone re-checking that the fragment
 * survived the edit.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import { fromBinary } from "@bufbuild/protobuf";
import { Protobuf } from "@meshtastic/core";

const README = readFileSync(new URL("../README.md", import.meta.url), "utf8");

const url = README.match(/https:\/\/meshtastic\.org\/e\/#[A-Za-z0-9_-]+/)?.[0];
const key = README.match(/\b[0-9a-f]{64}\b/)?.[0];
const fingerprint = README.match(/⌗([0-9a-f]{4})/)?.[1];

test("the README carries a channel link, a key and a fingerprint", () => {
  assert.ok(url, "no channel URL in the README");
  assert.ok(key, "no 32-byte key in the README");
  assert.ok(fingerprint, "no fingerprint in the README");
});

test("the link decodes to the channel the README describes", () => {
  const bytes = Buffer.from(url.split("#")[1].replace(/-/g, "+").replace(/_/g, "/"), "base64");
  const set = fromBinary(Protobuf.AppOnly.ChannelSetSchema, new Uint8Array(bytes));

  assert.equal(set.settings.length, 1, "the published link carries one channel");
  const channel = set.settings[0];
  assert.equal(channel.name, "le-space.de");
  assert.equal(
    crypto.createHash("sha256").update(Buffer.from(channel.psk)).digest("hex").slice(0, 4),
    fingerprint,
    "the fingerprint in the table is not this channel's",
  );
  assert.equal(Buffer.from(channel.psk).toString("hex"), key, "the key in the table is not in the link");

  // The table promises EU_868 · LONG_FAST, and a link without lora_config was
  // rejected on a real phone once already.
  assert.ok(set.loraConfig, "lora_config is missing");
  assert.equal(set.loraConfig.region, Protobuf.Config.Config_LoRaConfig_RegionCode.EU_868);
  assert.equal(set.loraConfig.modemPreset, Protobuf.Config.Config_LoRaConfig_ModemPreset.LONG_FAST);
});

test("the QR image encodes that same link", (t) => {
  // qrencode is how the image was made; without it there is nothing to compare
  // against, and a skipped check is honest where a silent pass is not.
  try {
    execFileSync("qrencode", ["--version"], { stdio: "ignore" });
  } catch {
    t.skip("qrencode is not installed");
    return;
  }
  const regenerated = execFileSync(
    "qrencode",
    ["-t", "SVG", "--svg-path", "--rle", "-m", "2", "-s", "4",
     "--background=FFFFFF", "--foreground=000000", "-o", "-", url],
    { encoding: "utf8" },
  );
  const shipped = readFileSync(new URL("../docs/img/channel-le-space.svg", import.meta.url), "utf8");
  assert.equal(regenerated, shipped, "the QR in the README is not this URL");
});
