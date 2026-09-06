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
 *   npm run channel -- --default --add    # put LongFast back after a replace
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
/**
 * A repeatable option, in the order it was written. Order is the whole point
 * for `--slot`: `ChannelSet.settings` is a repeated field, and the firmware
 * makes the **first** entry index 0 — the primary — with the rest secondary.
 */
const many = (name) => {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === `--${name}` && args[i + 1] !== undefined && !args[i + 1].startsWith("--")) {
      out.push(args[i + 1]);
    }
  }
  return out;
};

if (flag("help")) {
  console.log(`
  npm run channel -- [options]

  One channel:
    --name <text>       channel name, under 12 bytes   (default: bench)
    --psk <hex>         reuse a key instead of a new one — how you regenerate
                        the same channel later, or hand it to a third device
    --default           the public LongFast channel, to restore it after an
                        import replaced it — combine with --add to keep yours

  A whole channel set, in order — repeat --slot, first one becomes index 0:
    --slot default              the public LongFast channel
    --slot NAME                 a fresh key
    --slot NAME:<pskhex>        a key you already have
    --slot NAME:01              a name on the public key

    e.g.  --slot default --slot le-space.de:<hex>

    Index 0 decides the FREQUENCY: with channel_num at 0 the firmware derives
    the slot from the primary channel's name, so whatever you put first is
    where the radio listens — the other entries are keys, not frequencies.

  Both:
    --region <NAME>     firmware region name           (default: EU_868)
    --preset <NAME>     modem preset                   (default: LONG_FAST)
    --tx-power <dBm>    transmit power                 (default: 14)
    --hop-limit <n>     hops                           (default: 3)
    --channel-num <n>   pin the frequency slot instead of deriving it from the
                        primary channel's name — same number on every device
    --add               add alongside existing channels instead of replacing
    --no-qr             skip the QR code
`);
  process.exit(0);
}

// The public default is not a channel someone generated once: it is an empty
// name (so the preset supplies "LongFast") and a one-byte psk of 0x01, which
// the firmware reads as "the well-known key". Nothing about it is per-device,
// so it can always be rebuilt — unlike a channel whose key was only ever here.
const isDefault = flag("default");

const die = (message) => {
  console.error(`✗ ${message}`);
  process.exit(1);
};

/** A key as the firmware writes it: 16 or 32 bytes, or `01` for the public one. */
function parseKey(hex, where) {
  const psk = Buffer.from(hex.replace(/[^0-9a-f]/gi, ""), "hex");
  // `01` is the firmware's shorthand for the well-known public key, which is
  // how a named-but-public channel is written — a regional mesh that wants its
  // own frequency slot without wanting privacy.
  const isPublicShorthand = psk.length === 1 && psk[0] === 0x01;
  if (!isPublicShorthand && ![16, 32].includes(psk.length)) {
    die(`${where}: a key is 16 or 32 bytes, or \`01\` for the public one; got ${psk.length}`);
  }
  return psk;
}

function checkName(name, where) {
  if (name.length === 0 || name.length > 11) {
    die(`${where}: a channel name must be 1–11 bytes; "${name}" is ${name.length}`);
  }
  return name;
}

/**
 * One `--slot` argument: `default`, `NAME`, or `NAME:<pskhex>`.
 *
 * Split at the LAST colon and only when what follows is hex, so a name may
 * contain one without being mistaken for a key.
 */
function parseSlot(spec) {
  if (spec === "default") {
    return { isDefault: true, name: Buffer.alloc(0), psk: Buffer.from([0x01]) };
  }
  const at = spec.lastIndexOf(":");
  const hasKey = at > 0 && /^[0-9a-fA-F]+$/.test(spec.slice(at + 1));
  const name = checkName(Buffer.from(hasKey ? spec.slice(0, at) : spec, "utf8"), `--slot ${spec}`);
  const psk = hasKey ? parseKey(spec.slice(at + 1), `--slot ${name}`) : crypto.randomBytes(32);
  return { isDefault: false, name, psk };
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

const slotSpecs = many("slot");
if (slotSpecs.length > 8) die(`a device holds 8 channels; ${slotSpecs.length} were given`);
if (slotSpecs.length > 0 && (flag("default") || opt("name", null) || opt("psk", null))) {
  die("--slot builds the whole set; --name, --psk and --default describe a single channel");
}

/** Every channel to encode, in index order. Index 0 is the primary. */
const channels =
  slotSpecs.length > 0
    ? slotSpecs.map(parseSlot)
    : [
        isDefault
          ? { isDefault: true, name: Buffer.alloc(0), psk: Buffer.from([0x01]) }
          : {
              isDefault: false,
              name: checkName(Buffer.from(opt("name", "bench"), "utf8"), "--name"),
              psk: opt("psk", null) ? parseKey(opt("psk"), "--psk") : crypto.randomBytes(32),
            },
      ];

const txPower = Number(opt("tx-power", 14));
const hopLimit = Number(opt("hop-limit", 3));
// 0 means "derive the slot from the primary channel's name" — the firmware
// default, and the reason two devices with the same key can still be deaf to
// each other. A number pins the frequency and makes index 0 irrelevant to it.
const channelNum = Number(opt("channel-num", 0));
if (!Number.isInteger(channelNum) || channelNum < 0) die(`--channel-num takes a whole number`);

/* ── build ─────────────────────────────────────────────────────────────── */

// The default channel's name comes from the preset, so a different preset makes
// this a different channel on a different frequency slot — not the one that was
// lost. Refuse rather than hand back something that looks restored and is not.
if (isDefault && presetName !== "LONG_FAST") {
  console.error(`✗ --default is the public LongFast channel; --preset ${presetName} would be another channel`);
  process.exit(1);
}

// Derived from name and key so the same channel always carries the same id,
// and two independently generated ones never collide by accident. The default
// carries neither: an empty name and no id is exactly what the firmware ships.
for (const ch of channels) {
  ch.id = crypto.createHash("sha256").update(Buffer.concat([ch.name, ch.psk])).digest().readUInt32LE(0);
  ch.fingerprint = crypto.createHash("sha256").update(ch.psk).digest("hex").slice(0, 4);
  ch.settings = ch.isDefault
    ? lenDelim(2, ch.psk)
    : Buffer.concat([lenDelim(2, ch.psk), lenDelim(3, ch.name), fixed32(4, ch.id)]);
}

// proto3 omits default values, so a preset of LONG_FAST (0) is simply absent —
// which is what a link generated by the official app looks like too.
const lora = Buffer.concat([
  varField(1, 1), // use_preset
  ...(preset ? [varField(2, preset)] : []),
  varField(7, region),
  varField(8, hopLimit),
  varField(9, 1), // tx_enabled
  varField(10, txPower),
  ...(channelNum ? [varField(11, channelNum)] : []),
  varField(13, 1), // sx126x_rx_boosted_gain
]);

// `settings` is a repeated field: one length-delimited entry per channel, and
// the order on the wire is the order of the indices on the device.
const channelSet = Buffer.concat([
  ...channels.map((ch) => lenDelim(1, ch.settings)),
  lenDelim(2, lora),
]);
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
  if (!back.some((f) => f.field === 2)) throw new Error("lora_config is missing");
  const wireChannels = back.filter((f) => f.field === 1);
  if (wireChannels.length !== channels.length) {
    throw new Error(`${channels.length} channels went in, ${wireChannels.length} came back`);
  }
  // Order is checked as well as content: an index that shifts silently moves
  // the frequency, because the firmware derives the slot from whatever is first.
  channels.forEach((ch, index) => {
    const inner = decode(wireChannels[index].bytes);
    const gotPsk = inner.find((f) => f.field === 2).bytes;
    if (!gotPsk.equals(ch.psk)) throw new Error(`channel ${index}: key did not survive`);
    if (ch.isDefault) {
      // proto3 omits both, and their presence would make this a *named* channel
      // sharing the public key — which is not what the firmware ships.
      if (inner.some((f) => f.field === 3)) throw new Error("the default channel carries no name");
      if (inner.some((f) => f.field === 4)) throw new Error("the default channel carries no id");
    } else {
      const gotName = inner.find((f) => f.field === 3).bytes.toString("utf8");
      const gotId = inner.find((f) => f.field === 4).value;
      if (gotName !== ch.name.toString("utf8")) throw new Error(`channel ${index}: name did not survive`);
      if (gotId !== (ch.id >>> 0)) throw new Error(`channel ${index}: id did not survive`);
    }
  });
} catch (error) {
  console.error(`✗ refusing to print a link that does not decode: ${error.message}`);
  process.exit(1);
}

/* ── output ────────────────────────────────────────────────────────────── */

console.log();
console.log(`  ${url}`);
console.log();

for (const [index, ch] of channels.entries()) {
  const label = ch.isDefault ? "(default — the preset supplies “LongFast”)" : ch.name.toString("utf8");
  const role = index === 0 ? "primary" : "secondary";
  console.log(`  ${index}  ${label.padEnd(42)} ⌗${ch.fingerprint}  ${role}`);
  console.log(
    ch.isDefault
      ? `     key: the well-known public one — everybody can read this channel`
      : `     key: ${ch.psk.toString("hex")}`,
  );
}

console.log();
console.log(`  region        ${regionName} · ${presetName} · ${txPower} dBm · ${hopLimit} hops`);
console.log(
  channelNum
    ? `  frequency     slot ${channelNum}, pinned — the same number is needed on every device`
    : `  frequency     derived from »${channels[0].isDefault ? presetName : channels[0].name}« at index 0`,
);
if (channels.length === 1 && !channels[0].isDefault) {
  console.log(`                (--psk with the key above regenerates this exact channel)`);
}
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
console.log();
if (flag("add")) {
  console.log("  --add: this lands beside the existing channels and the current");
  console.log("  primary stays primary — so you keep the frequency slot you are on.");
} else {
  console.log("  ⚠ This link REPLACES the whole channel set. Every other channel on");
  console.log("    the device is erased, and a key that exists nowhere else is gone");
  console.log("    for good. Export what is on there first, or pass --add.");
  console.log();
  console.log("  Replacing makes this the primary — and the frequency slot follows the");
  console.log("  primary channel's name, so that is what moves you off the shared one.");
}
console.log();
