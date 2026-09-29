<!-- SPDX-License-Identifier: GPL-3.0-only -->

# mesh-heartbeat: how far does the mesh reach?

**[Demo](https://nikrause.github.io/funkpost/mesh-heartbeat/)** ·
tracking issue [#180](https://github.com/NiKrause/funkpost/issues/180) ·
the map is [#184](https://github.com/NiKrause/funkpost/issues/184)

The third demo, and the only one that carries **no database at all** — no
OrbitDB, no Yjs, nothing to replicate. One device stays where it is and
answers; the other goes for a ride and asks. What comes back is not *the mesh
works* but a list of places with an answer or a silence against each.

A range test that dragged a replication stack behind it would be measuring the
stack. This one sends 34 bytes and writes down what happened to them.

## What it measures, and what it refuses to

Each device keeps its own half of it, and the two are not the same record: the
phone knows where it was and whether an answer came back; the device that stays
knows what actually reached it and what it sent in reply. That matters, because
**a silence on the phone is two different failures** — a beat that never
arrived, and an answer that never made it home — and they are indistinguishable
from the saddle. Side by side they are not.

| it answers | it does not answer |
|---|---|
| was there an answer from *here* | how far the radio would reach from somewhere else |
| **on which beat** — the price of being heard | signal strength; the demo never reads RSSI or SNR |
| how far that place is from the stationary device | whether the path was direct or relayed by a third node |
| what the attempt cost in bytes and in airtime | whether a *list* would have replicated there |

The last one is the honest limit. A beat that gets through says the carrier
reached; it does not say a 5.7 KB bootstrap would have. What it does give is
the boundary to run that test inside.

**No ride has happened yet.** The wire sizes below are measured and the
arithmetic is exact, but every *track* this page has produced came out of a
`BroadcastChannel`. How far it actually reaches is a question only a bicycle
answers — [Run D](run-sheet.md#run-d-how-far-the-mesh-reaches) on the run
sheet.

## The two roles

| | **stays here and answers** | **travels and asks** |
|---|---|---|
| in the library | `beatsPerRound: 0`, `roundEveryMs: null` | three beats a round, a round every 1 / 2 / 5 min, or only on the button |
| sends | an echo for every beat it hears, at most one per 7.5 s per sender | a round, and an echo for anything it hears itself |
| position | announces where it is, **once** | says where it is on the **first beat of each round**, and records its own for every beat |
| a phone for it | anything that holds a Bluetooth link on a windowsill | the one in the pocket that is moving |

There is no list here, so the heartbeat's tag is the hash of a well-known
name — `funkpost/anybody-there/1`, the same one `mesh-todo` uses when it has
no list either. That is deliberate: **a mesh-todo phone left on the windowsill
is a perfectly good stationary half**, and it would not be if the two pages
hashed different names.

## A round, and why fifteen seconds

A round is **three beats fifteen seconds apart**, with a seven-and-a-half
second window after the last, and it **ends at the first answer**. So a good
spot costs one beat and a marginal one costs three: the beat number is the
price of being heard, not a detail.

It was very nearly twenty seconds instead, which was the first choice and does
not fit. `createHeartbeat` refuses a round that cannot end before the next one
starts, and three beats twenty seconds apart plus the window is seventy — ten
seconds longer than the shortest interval on offer:

```
beatsPerRound × gap + answerWindow  <  interval
      3       × 20 s  +    10 s     =    70 s    ✗ against 1 min
      3       × 15 s  +   7.5 s     =  52.5 s    ✓
```

The e2e suite shortens `minuteMs` with `?gap=` rather than waiting out a real
round.

## What a run costs

A beat is **34 bytes on the wire**, and saying where you are costs **15 more**
— both measured in `test/heartbeat.test.js`, not estimated. An answered round
is **cheaper than a lonely one**, because it stops early:

| on the channel | on the air, per interval | every 5 min | every 1 min |
|---|---|---|---|
| a rider nobody answers | 117 B — three beats, the first with a place | 1404 B/h · 5 % | 7020 B/h · 23 % |
| a rider and one answering device | 83 B | 996 B/h · 3 % | 4980 B/h · 17 % |
| a rider and three answering devices | 151 B | 1812 B/h · 6 % | 9060 B/h · 30 % |
| three riders, each hearing the others | 351 B | 4212 B/h · 14 % | 21 060 B/h · **70 %** |

The rule behind the table: a round's first beat is 49 B and the rest are 34;
an unanswered round is three of them; an answered one is the first **plus one
echo from every device that heard it**.

The percentages are of what this carrier was measured to move — about
[500 bytes a minute](field-notes.md#a-list-over-the-radio-with-nobodys-internet-on),
30 KB an hour — **not** of the legal duty cycle. Those are different ceilings,
and the node keeps its own count of the second one; see
[bench etiquette §6](bench-etiquette.md#6-watch-what-you-are-actually-spending).

Two things fall out of the table. **One minute is an interval for a short
deliberate ride**, not for leaving on. And **a crowd is expensive in a way one
rider cannot see**: three riders at a one-minute interval spend most of the
carrier between them, and each of them reads a page that says 20 %.

## Where each device says it is

Two rhythms, because there are two kinds of device.

**The one that stays says it once**, on its first message, and never again: it
has nothing to add by repeating itself.

**The one that moves says it on the first beat of every round.** That is fifteen
bytes a round rather than fifteen a beat — the whole ride would be a tax on a
carrier rationed by law, and one place per round is the resolution a round has
anyway. What it buys is that **the stationary device holds the ride too**: if
the phone loses its link, runs out of battery or is simply the unreliable half
of the pair, the measurement is not gone with it. The beats in between carry no
place and say so, rather than repeating the last one — a place that is actually
a guess would put a mark on a spot that was never measured.

It travels as two integers in Meshtastic's own scaling (`lat / 1e-7`), which
is what the node reports, so nothing is converted twice. `0, 0` is refused on
both ends — it is the Gulf of Guinea, and in practice it means *no fix*.

Where a position comes from, in order: **the node**, when it has a GPS or a
fixed position set in the Meshtastic app; otherwise **the browser**, which asks
permission. Without either, beats are still recorded — just without a place
against them.

## Two parties on one channel

A channel is shared, and this demo asks a question of **everyone** running it
with the same well-known name. If a second party is testing their own two
devices on the same channel at the same time, all four hear all four.

What that does to a measurement:

- **A stranger's node can answer your beat.** The beat counts as answered, and
  the row would record their coverage as yours.
- **Your track is still true about the air** — something did reach you there —
  **but false about the device you think you are measuring.**

So the page records **who answered** and shows it in the *answered by* column,
offers *whose answer counts* to pin one device, and warns as soon as more than
one has ever answered. Pick the partner once it has been heard and only its
answers count.

**Is a channel of your own better?** For the data, yes, and it is one
`npm run channel` away ([channels](channels.md)). For the air, it changes
nothing: a channel is a key, not a frequency. Everyone in EU 868 shares the
same 250 kHz whether or not they can decrypt each other, so a second party on
a second channel still costs you the airtime — and no longer answers your
beats. Two parties who *want* to measure together should stay on one channel
and pin partners; two who do not should still coordinate the hour.

## Running one

**In a browser first.** `?mesh=bc` replaces the radio with a
`BroadcastChannel`, so two tabs play the two devices:

| | |
|---|---|
| the one that stays | [`?mesh=bc&role=office`](https://nikrause.github.io/funkpost/mesh-heartbeat/?mesh=bc&role=office) |
| the one that rides | [`?mesh=bc&role=rider&every=1`](https://nikrause.github.io/funkpost/mesh-heartbeat/?mesh=bc&role=rider&every=1) |

Other parameters: `gap=` shortens the fifteen seconds, `every=` picks the
interval (`0` = only on the button), `loss=` drops frames on purpose,
`partner=` pins an answerer, `channel=` picks the transmit channel **by
name** (the index differs per device), `log=1` shows the field log.

**On real radios**, the setup, the steps and the pass line are
[Run D](run-sheet.md#run-d-how-far-the-mesh-reaches). Two things that are not
obvious and cost a run each: tick **keep the screen awake** — Web Bluetooth
pauses when the screen locks and nobody is watching the phone on a bicycle —
and check the **channel fingerprint** on both devices, because a mismatch is
silent and looks exactly like being out of range.

## What it has not shown yet

- **The ride itself** ([#180](https://github.com/NiKrause/funkpost/issues/180)).
  Built and deployed 2026-09-29, and that is all it proves.
- **The map** ([#184](https://github.com/NiKrause/funkpost/issues/184)). The
  track is a table; the same rows on OpenStreetMap tiles are the picture
  anybody would actually look at.
- **Export.** The track lives on the screen and in a screenshot. Nothing
  writes a file yet.

---

← [funkpost](../README.md) · [the byte courier](courier.md) ·
[links to a node](links.md) · [run sheet](run-sheet.md) ·
[field notes](field-notes.md)
