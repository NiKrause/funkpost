# Funkpost

[<img src="docs/badges/m-pwrd.svg" alt="Meshtastic Powered" width="84" align="right">](https://meshtastic.org)

*Post über Funk* — a byte courier for local-first applications over LoRa mesh
radios; works with Meshtastic® devices. A courier carries what it is handed,
and this one is handed three very different things: **handshakes, databases and
events.** One radio, three planes — they share the courier and nothing else, so
the difference gets a table, not a footnote:

| | **signalling plane** | **database plane** | **event plane** |
|---|---|---|---|
| what crosses the mesh | the WebRTC handshake: offer and answer, as small signed payloads | the database itself: OrbitDB entries, as signed blocks | one signed event at a time — and rules that *generate* a calendar instead of listing it |
| first contact | two frames | a few kilobytes, ~12 frames | tens of bytes; a three-week busy mask is one frame |
| WebRTC | yes — and the connection afterwards still needs an IP path (same Wi-Fi, or both online) | none — no offer, no answer, no IP path anywhere | none |
| built? | designed, **not built** | **built, and first over the air 4 Sep 2026** | **built, and first booking over the air 6 Sep 2026** |
| demo | — | [mesh-todo](https://nikrause.github.io/funkpost/mesh-todo/) | [mesh-calendar](https://nikrause.github.io/funkpost/mesh-calendar/) |
| the sentence to remember | *LoRa carries the handshake, not the connection.* | *The mesh carries the data when there is no connection to carry.* | *What you do not send costs nothing.* |

Both data planes are real and neither replaces the other: pick the database
plane when who wrote what must be **provable**, the event plane when the link
is the scarce thing. Design threads:
[libp2p-webrtc-qr#161](https://github.com/NiKrause/libp2p-webrtc-qr/issues/161),
[#1](https://github.com/NiKrause/funkpost/issues/1) and
[#38](https://github.com/NiKrause/funkpost/issues/38).

**A note on the third name.** It used to be "the Yjs plane", after the library.
The library changed underneath it — since [#45](https://github.com/NiKrause/funkpost/issues/45)
the bookings live in a signed claim log and Yjs carries only the shop's rules —
and the name went stale without anyone noticing, including in a sequence
diagram that showed bookings as Yjs updates for weeks. Naming a plane after
**what crosses it** survives a change of substrate. Naming it after the library
does not.

The announcement page for all three, written for humans:
[lora.le-space.de](https://lora.le-space.de/).

> ### ⚠ Experimental — not for production use
>
> This is a research project. It is **not audited**, and its purpose is to
> evaluate what a LoRa mesh can carry and how two devices reconcile data over
> it — throughput, airtime, convergence. Nothing more.
>
> **Authorisation has not been designed.** That is not an oversight to be found
> later; it is a gap that is known, measured, and stated here:
>
> - In `mesh-todo` the database is opened with `write: ["*"]`. **Anyone who
>   hears an invite may write to the list.**
> - In `mesh-calendar` a booking request carries no signature. A neighbour
>   with no key, no capability and no invitation can inject them — measured on
>   the demo's own default shop: **516 of 516 slots taken, all three weeks
>   gone, and the real customer's booking superseded**, because a forged
>   request may claim any timestamp it likes.
>
> The only boundary today is the **channel key**: whoever can decrypt the
> channel can write. On a public Meshtastic channel that is no boundary at all.
> A private channel is the difference between a demo and a toy, and it is still
> not authorisation.
>
> The examples are **demonstrators**, meant to be read and measured — not
> deployed, and not pointed at anybody's real calendar.

**Try it now.** Both demos are live, one per data plane — database and event —
and every push to main
redeploys both:

Both live at **[nikrause.github.io/funkpost](https://nikrause.github.io/funkpost/)**,
which is a menu:

| | | |
|---|---|---|
| **[…/mesh-todo/](https://nikrause.github.io/funkpost/mesh-todo/)** | `mesh-todo` | a todo list over LoRa — the **OrbitDB** plane |
| **[…/mesh-calendar/](https://nikrause.github.io/funkpost/mesh-calendar/)** | `mesh-calendar` | a hairdresser's appointment book — the **Yjs** plane |

Open either twice with `?mesh=bc` and two browser tabs play the two devices
(the booking demo wants `&role=salon` in one and `&role=customer` in the
other); with a Meshtastic node over Web Bluetooth, *Connect node* makes it
real.

## The test channel

<img src="docs/img/channel-le-space.svg" alt="QR code for the le-space.de test channel" width="150" align="right">

Two radios only hear each other if they carry the **same key**, so trying this
with someone else needs a shared one. This is ours — **scan the code with the
phone that holds your node**: the Meshtastic app's own scanner on Android, the
camera on iOS. Only the app can import a channel, which is why this is a code
and not a link.

| | |
|---|---|
| name | `le-space.de` · EU_868 · LONG_FAST |
| fingerprint | `⌗3dd3` — both demos show this beside the channel selector; **compare it across devices** |
| key | `5e08894adc2b00307796581213bbd9072bc1beaad48212d5a17873461d3e83fd` |

**This key is published, so this channel is public.** That is the point — it is
a meeting place, not a secret, and nothing here was ever protected by it
anyway. Bring your own channel (`npm run channel`) for anything else.

> ⚠ **Importing replaces the whole channel set.** Every other channel on the
> device is erased, including keys that exist nowhere else. Add `?add=true`
> before the `#`, or use the app's import-as-additional option.

Two settings on **your own node**, before you transmit — both explained in
[bench etiquette](docs/bench-etiquette.md):

- **Role `CLIENT_MUTE`.** A default node rebroadcasts everything it hears; on a
  busy mesh that is most of its airtime, spent on strangers' packets. Muted, it
  carries only your own traffic.
- **Preset `SHORT_TURBO`** for heavy benching — 21 880 bit/s against
  `LONG_FAST`'s 1 070, so the same frame costs a twentieth of the air, and
  range is irrelevant across a desk. It is not set here because **the preset is
  part of the air configuration**: everyone testing together has to change it
  at once, or they stop hearing each other.

## Status

**4 September 2026 — the first over-the-air replication.** A todo list
replicated end to end over a **real LoRa mesh** between two independent
Meshtastic nodes, with **no IP path**: `db.put` on one side, a delta over the
paced ARQ courier, the LoRa hop, `joinEntry` on the other, both lists
converged. Two desktop browsers, each driving its own node over Web Bluetooth.

Since then the **event plane** landed on the same courier, and on 6 September
carried a booking over real hardware: **31 s** to reach the shop, **9.3 s of
airtime** for the whole session. The courier needed no changes for it, which
was the claim worth testing.

**6 September 2026 — a booking crossed the mesh.** Two nodes, EU 868,
`LONG_FAST`, no IP path: a customer's booking travelled to the shop and stood in its day plan
**31 seconds** later — an appointment the shop never entered. The whole session cost **9.3 s of
airtime** — about 2.5 % of the hourly allowance.

What is *not* settled, and what each bench session cost, is kept honestly in
**[field notes](docs/field-notes.md)**. Sequencing and gates are in
**[ROADMAP.md](ROADMAP.md)**.

## The mesh carries the data, not the program

Worth stating because it is the obvious next question, and the answer is a
measurement rather than an opinion. `mesh-calendar`'s shell is **150 KB
gzipped**, and **85 KB of that is the Meshtastic library and the polyfills it
needs** — irreducible while a browser drives the radio over Web Bluetooth.
Dropping Svelte and the salon half saves perhaps a fifth, not an order of
magnitude.

Over LoRa that is ~780 frames: **hours** at `LONG_FAST` once the duty cycle is
counted, which is the binding limit, not the data rate. Set against the 9.3 s a
whole booking session costs, **shipping the app is roughly fifty times
everything it will ever do afterwards.**

So the app arrives once — over Wi-Fi, a hotspot at the counter, or a QR and one
moment of internet — and is a PWA from then on. After that it is offline, and
only the appointments use the radio. The one lever that would change the
arithmetic is not a smaller framework but a smaller *radio client*: Meshtastic
nodes also speak HTTP, and a thin client for the handful of message types this
uses would be a fraction of 85 KB.

## Where things are written down

The front page is deliberately short. One page per layer, each opening with
what is built and what is not:

| | |
|---|---|
| **[The byte courier](docs/courier.md)** | framing, selective-ACK ARQ, duty-cycle pacing — carries both planes, knows about neither |
| **[Links to a node](docs/links.md)** | Web Bluetooth reality, the reconnect policy, reading what the radio says |
| **[The database plane](docs/data-plane-orbitdb.md)** | OrbitDB: signed entries and an access controller; the bootstrap, end to end |
| **[The event plane's provider](docs/yjs-provider.md)** | the Yjs half of it: tiny, loss-tolerant updates — and reusable outside this project |
| **[mesh-calendar](docs/mesh-calendar.md)** | the event plane's demo — a shop's appointment book: rules not lists, who got the slot — and how to run its tests in a browser you can watch |
| **[The signalling plane](docs/signalling.md)** | designed, not built — LoRa carries the handshake, not the connection |
| **[Channels](docs/channels.md)** | getting two devices onto one channel — `npm run channel`, and why a mismatch is silent |
| **[Bench etiquette](docs/bench-etiquette.md)** | developing on a shared, legally rationed medium without ruining it for the neighbours |
| **[Field notes](docs/field-notes.md)** | what broke on real hardware, and why |
| **[Why a separate repository](docs/why-separate-repository.md)** | a licence decision, and a one-way door |

## Two data planes, one courier

The courier moves opaque bytes, so what sits on top is a choice — and both
choices ship:

| | **[database plane](docs/data-plane-orbitdb.md)** | **[event plane](docs/mesh-calendar.md)** |
|---|---|---|
| carries | the database: OrbitDB blocks, hash-linked and signed | one signed event at a time, plus rules that generate rather than list |
| gives you | verifiable history and an access controller | a greeting that does not grow: 111 bytes for three weeks at any number of writers |
| first contact | ~2 KB for a two-item list | tens of bytes |
| pick it when | who wrote what must be **provable** | the **link** is the scarce thing |

Its two structures are a Yjs document for the shop's rules and a signed claim
log for the bookings — the split [#45](https://github.com/NiKrause/funkpost/issues/45)
forced, when a Yjs state vector turned out to grow with every author who has
ever written and never shrink.

**The Yjs provider is reusable outside this project.** It needs only a courier
— any object with `send(bytes)` and `onPayload(cb)` — so a WebSocket, a
`BroadcastChannel` or your own transport works as well as a LoRa mesh:

```js
import { createYjsProvider } from "@le-space/funkpost/yjs";
const provider = createYjsProvider({ doc, courier });
```

`yjs` is an optional peer dependency behind its own subpath, so the byte
courier stays dependency-light for everyone else.

## The topology

```
   Phone A ──BLE── Node A ))))  LoRa  (((( Node B ──BLE── Phone B
      │                                                      │
      └── funkpost courier: framing · ARQ · duty-cycle pacing ┘
                    │                        │
       database plane                 event plane
```

No IP path anywhere in that picture. That is the whole point, and everything
else is detail — which now lives on its own page.

## Related work

The same courier pattern, on the same radios, applied to money:

- **[btcmesh](https://github.com/eddieoz/btcmesh)** — signed Bitcoin
  transactions over a Meshtastic mesh to a relay that broadcasts them.
- **[darkwire](https://github.com/cyb3r17/darkwire)** — a Bitcoin 2025
  hackathon project: an end-to-end Bitcoin transaction over LoRa, with no
  internet anywhere on the sender's side.

Neither is affiliated with funkpost; they are neighbours worth knowing about
— living proof that what fits through this pipe is exactly the small signed
payload.

The wider scene, with front doors of their own:

- **[Reticulum](https://reticulum.network/)** — the cryptography-first mesh
  stack; runs over LoRa, packet radio, Wi-Fi and everything in between.
- **[MeshCore](https://meshcore.co.uk/)** — a leaner LoRa mesh firmware
  building its own community alongside Meshtastic.
- **[qaul](https://qaul.net/)** — a messenger for internet shutdowns; devices
  connect directly over Bluetooth and Wi-Fi.

And the communities within radio range of this project's test channel:
**[Munich Mesh](https://munichmesh.de/)**,
**[Berlin Chaos Mesh](https://potatomesh.net/)**,
**[MeshHessen](https://meshhessen.de/)**, and the
**[Meshtastic local-groups directory](https://meshtastic.org/docs/community/local-groups/)**
for everything else.

## Trademarks

Meshtastic® is a registered trademark of Meshtastic LLC. Meshtastic software
components are released under various licenses, see GitHub for details. No
warranty is provided - use at your own risk.

LoRa® is a trademark of Semtech Corporation.

This project is not affiliated with or endorsed by Meshtastic LLC or Semtech;
it *works with* Meshtastic devices and is named to say so. The M-PWRD badge
above is the logo Meshtastic's [trademark policy](https://meshtastic.org/docs/legal/trademark/)
provides for projects using the technology, no grant required; the asset is the
official one from [meshtastic/design](https://github.com/meshtastic/design/tree/master/Meshtastic%20Powered%20Logo).
Commercial use of the Meshtastic firmware and marks carries their own terms in
addition to the GPLv3.

## Supporting this

[![Sponsor](https://img.shields.io/badge/Sponsor-NiKrause-FF6B5B?logo=githubsponsors&logoColor=white)](https://github.com/sponsors/NiKrause)

The work here is radios on a desk, hours of airtime, and the bench sessions
written up in the [field notes](docs/field-notes.md). Nothing about it is
funded, and nothing about it is for sale — it is GPL-3.0 and stays that way.

If it is useful to you, the **Sponsor** button at the top of this repository is
the least friction.

## Licence

GPL-3.0-only. See [LICENSE](LICENSE).
