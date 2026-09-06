#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only
/**
 * Make a Meshtastic channel and print it as an import link.
 *
 * Two devices on a bench must share one key. Creating a channel with the same
 * *name* on each does not do that — the keys differ, and the failure is silent:
 * both radios hear each other perfectly and decrypt nothing, which looks
 * exactly like nobody being there (docs/links.md). One link, scanned on both,
 * is the way to avoid it.
 *
 *   npm run channel                       # a fresh key, defaults for EU 868
 *   npm run channel -- --name bench-a
 *   npm run channel -- --preset SHORT_TURBO --tx-power 2
 *   npm run channel -- --psk <hex>        # reproduce an existing channel
 *
 * The ChannelSet protobuf is written by hand rather than through a library:
 * it is four fields, the runtime is not exported by @meshtastic/core, and a
 * dependency for forty lines of encoding is a poor trade. What that costs is
 * the risk of emitting something malformed, so the script decodes its own
 * output and checks it before printing — a link that does not survive its own
 * round trip is never shown.
 */

import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import { Protobuf } from "@meshtastic/core";

/* ── protobuf, the four fields we need ─────────────────────────────────── */

const varint = (n) => {
  const out = [];
  do {
    let byte = n & 0x7f;
    n >>>= 7;
    if (n) byte |= 0x80;
    out.push(byte);
  } while (n);
  return Buffer.from(out);
};
const lenDelim = (field, payload) =>
  Buffer.concat([varint((field << 3) | 2), varint(payload.length), payload]);
const varField = (field, value) => Buffer.concat([varint((field << 3) | 0), varint(value)]);
const fixed32 = (field, value) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(value >>> 0);
  return Buffer.concat([varint((field << 3) | 5), b]);
};

/** Walk a message; enough wire types for what we emit. */
function decode(buf) {
  const out = [];
  let i = 0;
  while (i < buf.length) {
    let tag = 0;
    let shift = 0;
    let byte;
    do {
      byte = buf[i++];
      tag |= (byte & 0x7f) << shift;
      shift += 7;
    } while (byte & 0x80);
    const field = tag >>> 3;
    const wire = tag & 7;
    if (wire === 0) {
      let value = 0;
      shift = 0;
      do {
        byte = buf[i++];
        value |= (byte & 0x7f) << shift;
        shift += 7;
      } while (byte & 0x80);
      out.push({ field, value });
    } else if (wire === 2) {
      let len = 0;
      shift = 0;
      do {
        byte = buf[i++];
        len |= (byte & 0x7f) << shift;
        shift += 7;
      } while (byte & 0x80);
      out.push({ field, bytes: buf.subarray(i, i + len) });
      i += len;
    } else if (wire === 5) {
      out.push({ field, value: buf.readUInt32LE(i) });
      i += 4;
    } else {
      throw new Error(`unexpected wire type ${wire} on field ${field}`);
    }
  }
  return out;
}

/* ── options ───────────────────────────────────────────────────────────── */

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 && args[at + 1] && !args[at + 1].startsWith("--") ? args[at + 1] : fallback;
};
const flag = (name) => args.includes(`--${name}`);

if (flag("help")) {
  console.log(`
  npm run channel -- [options]

    --name <text>       channel name, under 12 bytes   (default: bench)
    --region <NAME>     firmware region name           (default: EU_868)
    --preset <NAME>     modem preset                   (default: LONG_FAST)
    --tx-power <dBm>    transmit power                 (default: 14)
    --hop-limit <n>     hops                           (default: 3)
    --psk <hex>         reuse a key instead of a new one — how you regenerate
                        the same channel later, or hand it to a third device
    --add               add alongside existing channels instead of replacing
    --no-qr             skip the QR code
`);
  process.exit(0);
}

const name = Buffer.from(opt("name", "bench"), "utf8");
if (name.length === 0 || name.length > 11) {
  console.error(`✗ a channel name must be 1–11 bytes; "${name}" is ${name.length}`);
  process.exit(1);
}

const regionName = opt("region", "EU_868");
const region = Protobuf.Config.Config_LoRaConfig_RegionCode[regionName];
if (typeof region !== "number") {
  console.error(`✗ unknown region "${regionName}"`);
  process.exit(1);
}

const presetName = opt("preset", "LONG_FAST");
const preset = Protobuf.Config.Config_LoRaConfig_ModemPreset[presetName];
if (typeof preset !== "number") {
  console.error(`✗ unknown modem preset "${presetName}"`);
  process.exit(1);
}

const pskHex = opt("psk", null);
let psk;
if (pskHex) {
  psk = Buffer.from(pskHex.replace(/[^0-9a-f]/gi, ""), "hex");
  if (![16, 32].includes(psk.length)) {
    console.error(`✗ a key is 16 or 32 bytes; got ${psk.length}`);
    process.exit(1);
  }
} else {
  psk = crypto.randomBytes(32);
}

const txPower = Number(opt("tx-power", 14));
const hopLimit = Number(opt("hop-limit", 3));

/* ── build ─────────────────────────────────────────────────────────────── */

// Derived from name and key so the same channel always carries the same id,
// and two independently generated ones never collide by accident.
const id = crypto.createHash("sha256").update(Buffer.concat([name, psk])).digest().readUInt32LE(0);

const settings = Buffer.concat([lenDelim(2, psk), lenDelim(3, name), fixed32(4, id)]);

// proto3 omits default values, so a preset of LONG_FAST (0) is simply absent —
// which is what a link generated by the official app looks like too.
const lora = Buffer.concat([
  varField(1, 1), // use_preset
  ...(preset ? [varField(2, preset)] : []),
  varField(7, region),
  varField(8, hopLimit),
  varField(9, 1), // tx_enabled
  varField(10, txPower),
  varField(13, 1), // sx126x_rx_boosted_gain
]);

const channelSet = Buffer.concat([lenDelim(1, settings), lenDelim(2, lora)]);
const encoded = channelSet
  .toString("base64")
  .replace(/\+/g, "-")
  .replace(/\//g, "_")
  .replace(/=+$/, "");
// The query goes BEFORE the fragment: everything after '#' is the payload, and
// appending to it corrupts the base64 instead of adding a parameter.
const url = `https://meshtastic.org/e/${flag("add") ? "?add=true" : ""}#${encoded}`;

/* ── prove it before printing it ───────────────────────────────────────── */

try {
  const back = decode(
    Buffer.from(encoded.replace(/-/g, "+").replace(/_/g, "/"), "base64"),
  );
  const inner = decode(back.find((f) => f.field === 1).bytes);
  const gotPsk = inner.find((f) => f.field === 2).bytes;
  const gotName = inner.find((f) => f.field === 3).bytes.toString("utf8");
  const gotId = inner.find((f) => f.field === 4).value;
  if (!gotPsk.equals(psk)) throw new Error("key did not survive the round trip");
  if (gotName !== name.toString("utf8")) throw new Error("name did not survive the round trip");
  if (gotId !== (id >>> 0)) throw new Error("id did not survive the round trip");
  if (!back.some((f) => f.field === 2)) throw new Error("lora_config is missing");
} catch (error) {
  console.error(`✗ refusing to print a link that does not decode: ${error.message}`);
  process.exit(1);
}

/* ── output ────────────────────────────────────────────────────────────── */

const fingerprint = crypto.createHash("sha256").update(psk).digest("hex").slice(0, 4);

console.log();
console.log(`  ${url}`);
console.log();
console.log(`  name          ${name}`);
console.log(`  fingerprint   ⌗${fingerprint}   ← must read the same on every device`);
console.log(`  region        ${regionName} · ${presetName} · ${txPower} dBm · ${hopLimit} hops`);
console.log(`  key           ${psk.toString("hex")}`);
console.log(`                (--psk with that value regenerates this exact channel)`);
console.log();

if (!flag("no-qr")) {
  try {
    // A link you can scan beats a link you have to retype onto a phone.
    console.log(execFileSync("qrencode", ["-t", "UTF8", "-m", "1", url], { encoding: "utf8" }));
  } catch {
    console.log("  (install qrencode for a scannable code: brew install qrencode)\n");
  }
}

console.log("  Scan or open it on EVERY device that should share this channel.");
console.log("  Importing without --add replaces the channel set, which makes this");
console.log("  the primary — and the frequency slot follows the primary channel's");
console.log("  name, so that is what moves you off the shared one.");
console.log();
