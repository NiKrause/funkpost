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

> To try the demos with someone else, there is a published channel with a QR
> code in the [README](../README.md#the-test-channel) — `le-space.de`, `⌗3dd3`.
> Its key is public, which is exactly what a meeting place needs and exactly
> what a private channel must not be.

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
| `--default` | the public LongFast channel, to put back after a replace |
| `--add` | add alongside existing channels instead of replacing them |
| `--no-qr` | skip the code |

A bench channel, off the busy defaults and cheap on airtime:

```bash
npm run channel -- --name bench --preset SHORT_TURBO --tx-power 2
```

### A whole channel set, in one link

`ChannelSet.settings` is a repeated field, so one link can carry every channel
a device should have — and put them in a fixed order, which is how two devices
end up genuinely identical instead of approximately:

```bash
npm run channel -- --slot default --slot le-space.de:5e08894a…83fd
```

`default`, `NAME`, or `NAME:<pskhex>` — a bare name generates a fresh key.
Scanned on every device, everyone gets the same channels at the same indices.
Anything else you belong to is then one more scan, from whoever runs it, using
their own share link with *add*.

**Which order is right is your decision, not ours** — but it is a decision, and
this is what it decides:

> **Index 0 picks the frequency, not the membership.** With `channel_num` at 0
> the firmware derives the radio's slot from the *primary* channel's name, so
> whatever you put first is where the radio actually listens. Everything after
> it is a key for traffic that arrives there.
>
> **A radio has one frequency.** Adding a channel does not add one. You cannot
> sit on two slots at once, however many channels the device holds — so index 0
> is really the question *"which group am I reachable in right now?"*

`--channel-num <n>` pins the slot instead, the same number on every device.
Then index 0 no longer decides it, and the order is free — still one frequency,
but one you chose rather than one that fell out of a name.

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

> **Replacing erases every other channel on the device.** Not just moves it
> aside — the channel set is overwritten. If one of those channels held a key
> that exists nowhere else, it is gone. Export first, or use `--add`.

## Getting a channel back after a replace

Which is possible depends on where the key came from, and that is the whole
distinction:

**The public default** always comes back, because nothing about it is
per-device. Its name is empty — the preset supplies *LongFast* — and its key is
a single byte, `0x01`, which the firmware reads as *the well-known one*:

```bash
npm run channel -- --default --add
```

`--add` keeps whatever you imported over it. Drop it if you want LongFast to be
the primary again, and with it the shared frequency slot. There is a test
pinning our output to the canonical `#CgMSAQE`, so this is a rebuild, not an
imitation.

**A community channel — a regional mesh, say — cannot be rebuilt here.** Its key
was generated by whoever set it up, and we never had it. Three ways back, in
order of how well they work:

1. **Another of your own devices.** If it still has the channel, the Meshtastic
   app's share function exports it: channel settings → share → QR. This is the
   reliable one, and the reason to do the recovery before touching the second
   device.
2. **Whoever runs the mesh.** Regional meshes usually publish their link.
3. **Only if it is known to use the public key.** Some open meshes are a *name*
   and nothing else: the custom name moves them to their own frequency slot
   while the key stays the well-known one, so anyone may join. `01` is the
   firmware's shorthand for that key:

   ```bash
   npm run channel -- --name open-mesh --psk 01
   ```

   **This is not a recovery method, and guessing it is worse than useless.**
   A mesh that has its own key — the normal case — cannot be reconstructed
   from its name. What you get
   instead is a channel with the right name that talks to nobody: exactly the
   silent failure at the top of this page, now wearing a familiar label. The
   fingerprint will not catch it either, since it would legitimately be the
   public key's. Use this only when someone who runs the mesh has said it is
   open, never to find out whether it is.

## Where a key should live

A channel key is small, it is the whole channel, and it exists only where you
put it. The two ways of keeping one are opposites, and which is right follows
entirely from what the channel is for:

**A meeting place is published.** `le-space.de` is in the README, in this
repository's history, in every clone and on the website. It cannot be lost —
`--psk` rebuilds it byte for byte from the printed hex, and there is a test
that says so. What that costs is privacy, and a channel whose job is letting
strangers try a demo together never had any to spend.

**A private channel is backed up, or it dies with the devices.** Somewhere that
survives a factory reset and a lost phone: a password manager, or the same
place your other secrets live. Not a note in this repository — a key committed
to a public repository is a published key, whatever you meant by it.

The failure mode is worth stating plainly, because it has already happened
here: **a key you publish cannot be lost; a key you protect can.** A regional
mesh channel went when one device's channel set was replaced, and it was
recoverable only because two other devices still held it. Two devices is not a
backup; it is two copies of one accident away from nothing.

That also decides what `npm run channel` prints. The key goes to the terminal
in full, in hex, next to the line saying `--psk` reproduces the channel from
it — because the moment to write a key down is the moment it is created, and a
tool that hides it guarantees nobody does.

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
