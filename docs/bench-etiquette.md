<!-- SPDX-License-Identifier: GPL-3.0-only -->

# Developing without ruining the neighbourhood's mesh

Status: **operational guidance** — the settings are Meshtastic's, the reasoning
is ours, and the numbers come from `lib/pacing.js` and `lib/regions.js`.

A LoRa mesh is a shared, legally rationed medium. In EU 868 the whole band gives
each transmitter **10 % of an hour — six minutes** (ETSI EN 300 220), and a
community mesh may have a hundred neighbours in earshot. A development loop that
retransmits enthusiastically is not just slow for you; it is everybody's
afternoon.

Ordered by how much they actually help.

## 1. Do not use the radio at all

Most development needs no radio and should not have one.

```
?mesh=bc          two browser tabs play the two devices, over a BroadcastChannel
npm test          the in-memory mesh — MTU enforced, loss and reordering on request
npm run test:e2e  the full script, both roles, still no radio
```

The in-memory mesh (`lib/links/memory-mesh.js`) enforces the real MTU and
misbehaves on request, so protocol bugs surface there. The radio is for
*confirming* what already works, not for finding out whether it does.

**This is where 95 % of the time should go.** Everything below is about the
other 5 %.

## 2. Leave the shared frequency — a private channel is not enough

The most common mistake, and it is worth being precise about.

A Meshtastic **channel is a key, not a frequency.** Every channel on the same
region and modem preset shares one radio slot. So creating a private channel:

- stops other people **reading** your traffic ✓
- stops your traffic **appearing** in their app ✓
- reduces the airtime you take from them — **not at all** ✗

Your packets still occupy the same air, still collide with theirs, still count
against the same duty cycle. Everyone in range still pays for your test run;
they simply cannot see what they are paying for.

To actually get out of the way, move the **frequency slot**. In the LoRa config
that is `channel_num` — and when it is left at `0`, the slot is derived from a
hash of the **primary channel's name**. So giving your development channel its
own name usually moves it off the shared slot as a side effect. Verify rather
than assume: if the neighbours stop appearing in your node's list, you have
moved.

Keep the same slot on all three of your devices, obviously, or they will not
hear each other either — the failure that looks exactly like nobody being there
(see [links.md](links.md)).

`npm run channel` makes one channel and prints it as a link and a QR to scan on
every device, which is the reliable way to get identical keys — see
[channels.md](channels.md). Creating a channel with the same *name* on each
device does not do it: the names match, the keys do not.

## 3. Stop relaying other people's traffic

A default node **rebroadcasts** what it hears. On a busy mesh that is most of
its airtime, spent on packets that have nothing to do with you — and it is the
single biggest contribution a bench node makes to congestion.

Set the device role to **`CLIENT_MUTE`**. It sends and receives its own traffic
and relays nothing. For a node sitting on a desk next to two others, relaying
serves nobody.

## 4. Use a fast modem preset

Range is irrelevant across a desk, and the presets differ by a factor of twenty:

| preset | data rate | airtime for a 200-byte frame |
|---|---|---|
| `LONG_FAST` (default) | 1 070 bit/s | ~1.8 s |
| `SHORT_FAST` | 10 940 bit/s | ~170 ms |
| `SHORT_TURBO` | 21 880 bit/s | ~90 ms |

The same test run costs **twenty times less air** on `SHORT_TURBO`, and every
round trip returns twenty times sooner, so the bench is also far less tedious.

The courier reads the preset from the node and paces to it — the figures above
come from `PRESET_DATA_RATES_BPS`. If it did not, pacing would be wrong by that
same factor of twenty, which is why it is read rather than assumed.

## 5. Turn the transmitter down — but do not expect a short range

Lower `tx_power` is worth setting: three devices within a metre do not need full
power, and it shrinks your footprint on everyone else's receiver.

What it will **not** do is confine you to the desk. The arithmetic, at 868 MHz:

| | |
|---|---|
| free-space path loss at 2 m | **37 dB** |
| link budget at minimum power (0 dBm) and the *least* sensitive preset | **117 dB** |
| surplus | **80 dB** — about 19 km of free space |

Even turned all the way down and running SHORT_TURBO, a LoRa link has roughly
**eighty decibels more than it needs** to cross a room. That is the whole point
of the modulation, and it is not a setting you can undo. `LONG_FAST` at 0 dBm
has ninety.

If you genuinely need a short link — to stop bench traffic reaching a mesh you
are also observing, say — the only honest way is to **throw the power away in a
cable**: screw-on SMA attenuators between radio and antenna, roughly 60–80 dB
total. They cost a few euros each and are the tool laboratories use.

Do **not** simply unscrew the antenna. It attenuates far less than people
expect, it radiates unpredictably, and transmitting into an open port reflects
power back into the amplifier. It is neither controlled nor kind to the
hardware.

And the conclusion that matters: **range is the wrong lever for being a good
neighbour.** Even a well-attenuated bench still lands in everyone's receiver
with margin to spare, and the duty cycle binds you regardless of how far you
reach. What actually spares the neighbourhood is being somewhere else in the
spectrum (§2) and not relaying its traffic (§3).

## The firmware enforces this, and will tell you

You are not the only one counting. The node measures its own transmit airtime
and **refuses to exceed the regional limit itself** — the client gets routing
error **`DUTY_CYCLE_LIMIT`** back, and the packet does not go out. There is a
`override_duty_cycle` flag in the LoRa config; in the EU, setting it is
unlawful, and it exists for regions without a limit.

So there are two limiters, and they are not redundant:

- **The firmware's** is the authority and counts *everything* the radio does,
  including beacons, telemetry and relaying for the mesh.
- **The courier's** paces ahead of it, so traffic is spread out instead of
  arriving in a burst that gets refused.

The courier reconciles its budget against the device's own `air_util_tx`
figure, because a local model cannot see the airtime the radio spends on its
own behalf.

When a refusal does arrive, it is treated as *"not yet"* rather than a failure:
the frame stays outstanding, the local budget is emptied so pacing backs off,
and the wave is not counted as a delivery attempt. That last part matters —
without it the ARQ exhausts its rounds waiting for a budget that recovers more
slowly than the retransmit timer ticks, and the payload is dropped over a limit
that expires by itself.

## 6. Watch what you are actually spending

Both demos show the node's **own measured** airtime utilisation (`air_util_tx`)
— which counts everything the radio does, including beacons, telemetry and any
relaying, not just this app. The courier reconciles its budget against that
number, because the device is what the duty cycle binds.

If it climbs while you are idle, something other than your app is spending it.

## A three-device bench

With three nodes the useful arrangement is **two participants and one witness**:
two run the demo, the third sits in the official Meshtastic app on the same
channel and simply watches. It answers the question that costs the most time —
*is anything reaching the air at all* — without adding traffic of its own.

## The short version

| | |
|---|---|
| **Do** | develop with `?mesh=bc` · own frequency slot · `CLIENT_MUTE` · `SHORT_TURBO` · low power |
| **Do not** | develop on the default public channel · assume a private channel spares the neighbours · leave rebroadcast on |

---

← [funkpost](../README.md) · [ROADMAP](../ROADMAP.md)
