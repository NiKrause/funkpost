<!-- SPDX-License-Identifier: GPL-3.0-only -->

# Getting two devices onto the same channel

Status: **a working tool and a procedure** — `npm run channel` is tested, the
node-side steps are Meshtastic's and have to be done by hand.

Nothing in this project can talk to another device until both radios share one
channel. That sounds obvious and is the single most expensive thing to get
wrong here, because **getting it wrong is silent**.

## Why it is silent, and what it looks like

A packet the node cannot decrypt is dropped inside the client library with a
`log.debug` line and nothing else. It never reaches a port, so the app's
received-frame count stays at **zero — exactly as if nobody were there at all**
([links.md](links.md)).

So a key mismatch and an empty room are indistinguishable, and the symptom is:

```
Frames 85→  ←0      Runden 80      Sendungen 3→ ←0
```

Both sides transmitting energetically, neither receiving anything. If you ever
see `←0` on both devices at once, check the channel before you check anything
else.

**Creating a channel with the same *name* on each device does not work.** The
names match; the keys do not. Both radios then hear each other perfectly and
decrypt nothing. One key has to be generated once and carried to every device.

## Make a channel

```bash
npm run channel
```

```
  https://meshtastic.org/e/#CjQSIGJCxytOp0PE281TC9F1o2A0om1yHiH9lyN7BtLG4OrM…

  name          le-space.de
  fingerprint   ⌗f93e   ← must read the same on every device
  region        EU_868 · LONG_FAST · 14 dBm · 3 hops
  key           6242c72b4ea743c4dbcd530bd175a36034a26d721e21fd97237b06d2c6e0eacc
```

…followed by a QR code in the terminal, if `qrencode` is installed
(`brew install qrencode`). Scan it with each phone; that is the whole procedure.

| option | |
|---|---|
| `--name <text>` | channel name, **1–11 bytes** (Meshtastic's limit, checked) |
| `--region <NAME>` | `EU_868`, `US`, … — validated against the firmware enum |
| `--preset <NAME>` | `LONG_FAST` (default), `SHORT_TURBO`, … |
| `--tx-power <dBm>` | default 14 |
| `--hop-limit <n>` | default 3 |
| `--psk <hex>` | reuse a key instead of generating one |
| `--add` | add alongside existing channels instead of replacing them |
| `--no-qr` | skip the code |

A bench channel, off the busy defaults and cheap on airtime:

```bash
npm run channel -- --name bench --preset SHORT_TURBO --tx-power 2
```

### Getting the same channel back later

The key is printed, so the channel is reproducible — for a third device that
turns up next week, or after a factory reset:

```bash
npm run channel -- --name bench --psk 6242c72b…eacc
```

Same key in, same link out. There is a test for that.

## Import it, and check

Scan or open the link on **every** device. Then, in either demo, the transmit
channel selector beside the link indicator shows the name and the first two
bytes of the key's SHA-256:

```
Sendekanal: 1 »le-space.de« ⌗f93e
```

**Compare that fingerprint across devices.** It is the only reliable check —
a channel can carry a familiar name and a completely different key, and the
name will not tell you.

## Replace, or add?

The default **replaces** the channel set, which makes your channel the primary
one. That is usually what you want, because Meshtastic derives the **frequency
slot** from the primary channel's name (while `channel_num` is 0). A different
name therefore moves you off the slot the neighbourhood is using — which is the
part that actually spares them airtime, as opposed to merely encrypting your
traffic ([bench-etiquette.md](bench-etiquette.md)).

With `--add` the channel lands beside the existing ones, the default stays
primary, and you are encrypted but still in the same crowd.

**How to tell which happened:** after importing, the neighbours should disappear
from the node's list. If they are still there, you did not move.

## If a link is refused

Use the Meshtastic app's own share function instead: create the channel on one
device, tap share, scan the QR with the other. It is guaranteed valid because
the app produced it — and identical keys are the only thing that actually
matters here, not where the link came from.

## What the script does, and why it is written this way

It encodes a `ChannelSet` protobuf — key, name, id, and the LoRa config — as
URL-safe base64 in the fragment. The protobuf is written by hand: it is four
fields, `@meshtastic/core` does not export a protobuf runtime, and a dependency
for forty lines of encoding is a poor trade.

The cost of hand-encoding is the risk of emitting something malformed, so the
script **decodes its own output and verifies it** before printing — key, name
and id must survive the round trip and the LoRa config must be present. A link
that fails its own check is never shown. Both of those requirements come from
comparing against a real, working Meshtastic link: an early version omitted the
channel `id` and a full `lora_config`, and was rejected on the phone.

One more thing that reads as a detail and is not: `?add=true` goes **before**
the `#`. Everything after the hash is the payload, so appending there corrupts
the base64 rather than adding a parameter.

---

← [funkpost](../README.md) · [ROADMAP](../ROADMAP.md)
