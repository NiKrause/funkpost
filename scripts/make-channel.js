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
 *   npm run channel -- --preset SHORT_FAST --tx-power 2
 *   npm run channel -- --psk <hex>        # reproduce an existing channel
 *   npm run channel -- --default --add    # put LongFast back after a replace
 *
 * The ChannelSet is built from Meshtastic's **own** schema
 * (`Protobuf.AppOnly.ChannelSetSchema`) with the official protobuf runtime, so
 * nothing about the wire format is reimplemented here. `@meshtastic/core`
 * bundles that runtime without re-exporting it, which is why `@bufbuild/protobuf`
 * appears as a devDependency; an earlier version of this script hand-rolled the
 * encoding on the assumption that no runtime was available. It produced
 * byte-identical output, which is a poor reason to keep ninety lines of varint
 * arithmetic in a repository.
 *
 * What is genuinely ours is the part no library offers: turning a ChannelSet
 * into the `meshtastic.org/e/#…` link. That format lives in Meshtastic's *web
 * client*, not in the core package.
 */

import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import { create, toBinary, fromBinary } from "@bufbuild/protobuf";
import { Protobuf } from "@meshtastic/core";

const ChannelSet = Protobuf.AppOnly.ChannelSetSchema;

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
}

// `settings` is a repeated field, and the order on the wire is the order of the
// indices on the device. proto3 leaves default values off the wire, so the
// public channel's empty name and absent id fall out on their own — and a
// LONG_FAST preset (0) is simply not written, exactly as the official app's
// own links look.
const message = create(ChannelSet, {
  settings: channels.map((ch) =>
    ch.isDefault
      ? { psk: new Uint8Array(ch.psk) }
      : { psk: new Uint8Array(ch.psk), name: ch.name.toString("utf8"), id: ch.id },
  ),
  loraConfig: {
    usePreset: true,
    modemPreset: preset,
    region,
    hopLimit,
    txEnabled: true,
    txPower,
    channelNum,
    sx126xRxBoostedGain: true,
  },
});

const encoded = Buffer.from(toBinary(ChannelSet, message))
  .toString("base64")
  .replace(/\+/g, "-")
  .replace(/\//g, "_")
  .replace(/=+$/, "");
// The query goes BEFORE the fragment: everything after '#' is the payload, and
// appending to it corrupts the base64 instead of adding a parameter.
const url = `https://meshtastic.org/e/${flag("add") ? "?add=true" : ""}#${encoded}`;

/* ── prove it before printing it ───────────────────────────────────────── */

// The protobuf itself is the library's business now, so this no longer guards
// against a hand-rolled encoder. What it still guards is ours: the URL-safe
// base64 and the stripped padding, plus the *order* of the channels — an index
// that shifts silently moves the frequency, because the firmware derives the
// slot from whatever ends up first.
try {
  const back = fromBinary(
    ChannelSet,
    new Uint8Array(Buffer.from(encoded.replace(/-/g, "+").replace(/_/g, "/"), "base64")),
  );
  if (!back.loraConfig) throw new Error("lora_config is missing");
  if (back.settings.length !== channels.length) {
    throw new Error(`${channels.length} channels went in, ${back.settings.length} came back`);
  }
  channels.forEach((ch, index) => {
    const got = back.settings[index];
    if (!Buffer.from(got.psk).equals(ch.psk)) throw new Error(`channel ${index}: key did not survive`);
    const wantName = ch.isDefault ? "" : ch.name.toString("utf8");
    if (got.name !== wantName) throw new Error(`channel ${index}: name did not survive`);
    // The public channel carries no id; giving it one would make it a *named*
    // channel that happens to share the public key, which is a different thing.
    if (got.id !== (ch.isDefault ? 0 : ch.id >>> 0)) {
      throw new Error(`channel ${index}: id did not survive`);
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

console.log("  Scan it with EVERY phone that should share this channel — from the");
console.log("  Meshtastic app's scanner on Android, the camera on iOS. A channel link");
console.log("  means nothing to a desktop browser; only the app can import one.");
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
