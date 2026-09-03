# libp2p-webrtc-qr over Meshtastic

Signalling for [libp2p-webrtc-qr](https://github.com/NiKrause/libp2p-webrtc-qr)
over a Meshtastic LoRa mesh: the WebRTC offer and answer travel as small signed
payloads between two nodes, so the handshake needs no camera, no messenger and
no speaker — and works through walls and across floors.

**Nothing is built yet.** This repository exists so the work has somewhere to
live that is licensed correctly, and so the reason for its separateness is
written down where somebody will find it. The design lives in
[libp2p-webrtc-qr#161](https://github.com/NiKrause/libp2p-webrtc-qr/issues/161).

---

## Why this is a separate repository

**Licence, not taste.** [`@meshtastic/core`](https://www.npmjs.com/package/@meshtastic/core)
and `@meshtastic/transport-web-bluetooth` are **GPL-3.0-only**.
`@le-space/libp2p-webrtc-qr` is **Apache-2.0 OR MIT**, and a permissive library
that pulled GPL-3.0 into its consumers' builds would be misrepresenting its own
licence — the optional-peer-dependency pattern it uses for `ggwave` works
because ggwave is MIT.

The demo in that repository is no refuge either: it is `private: true` but it is
*distributed*, from a public address, so bundling GPL-3.0 there would make the
deployed application GPL-3.0.

So this repository is **GPL-3.0**, and it depends on
`@le-space/libp2p-webrtc-qr` rather than the other way round. Permissive flows
into copyleft; the reverse is what fails.

One consequence worth stating in advance: any piece of this that turns out to
belong in the library — the carrier-neutral framing, for instance — has to be
written **there**, under the permissive licence, and used from here. Designing it
here and wanting it back later does not work.

## What it will do

```
phone ↔ BLE ↔ its own node ↔ LoRa ↔ studio node ↔ BLE ↔ tablet
```

A browser reaches a Meshtastic node over Web Bluetooth
([`@meshtastic/transport-web-bluetooth`](https://meshtastic.org/docs/development/js/),
the only transport that fits a phone), and the two nodes carry the payloads. One
BLE client per node is a firmware rule, so each side brings its own.

**It uses the compact (v3) payload explicitly.** ~284 bytes is two LoRa packets
where a full SDP is five or six, under EU 868's 10 % duty cycle — and that
applies twice, once per direction. v3 also carries its own identity binding,
which matters more here than on a screen: a mesh is readable by everyone in RF
range, and a courier can substitute a signed payload of its own.

## What LoRa does **not** do

**It carries the handshake, not the connection.** WebRTC still needs an IP path
between the peers — the same Wi-Fi, or both online with NAT traversal working.
Two peers linked only by mesh will verify each other's signatures perfectly and
never connect. This is the sentence most likely to be misread, so it is here
rather than in a footnote.

## Before any code

Three questions are answerable on hardware and two of them can end the idea.
They are the gate:

1. **How long does one handshake take over a single hop?** Compact offer plus
   answer, LongFast, quiet channel. The estimate is 15–45 s; minutes would kill
   the in-the-room case and leave only long range.
2. **Does `watchAdvertisements()` work without a Chrome flag?** Decides whether
   a waiting phone listens for a free BLE slot or falls back to jittered polling.
3. **Does a node refuse a second BLE client, or evict the first?** The failure
   mode decides how a shared "guest node" behaves when somebody taps at the
   wrong moment.

## Trademark

Meshtastic is a trademark of its owners. This project is not affiliated with or
endorsed by them; it *works with* Meshtastic devices and is named to say so.
Commercial use of the Meshtastic firmware and marks carries their own terms in
addition to the GPLv3.

## Licence

GPL-3.0-only. See [LICENSE](LICENSE).
