# libp2p-webrtc-qr over Meshtastic

Two planes over one radio:

- **Signalling** for [libp2p-webrtc-qr](https://github.com/NiKrause/libp2p-webrtc-qr):
  the WebRTC offer and answer travel as small signed payloads between two
  Meshtastic nodes, so the handshake needs no camera, no messenger and no
  speaker — and works through walls and across floors. Design:
  [libp2p-webrtc-qr#161](https://github.com/NiKrause/libp2p-webrtc-qr/issues/161).
- **Data**, for peers with no IP path at all: an OrbitDB database replicates
  entry by entry over the mesh — signed blocks over the radio, big things via
  Storacha once one side finds the internet again. Design and arithmetic:
  [issue #1](https://github.com/NiKrause/libp2p-webrtc-qr-meshtastic/issues/1).

## What is here now

The byte courier the data plane runs on (plan step S2 in issue #1), radio-free
and fully tested:

- [`lib/framing.js`](lib/framing.js) — fragments sized to a mesh packet
  (`id · idx/total`), plus a STATUS frame carrying the receiver's bitmap
- [`lib/meshtastic-courier.js`](lib/meshtastic-courier.js) — selective-ACK ARQ
  over any link: retransmits exactly the missing fragments, bounded rounds,
  `send()` resolves on end-to-end acknowledgement
- [`lib/pacing.js`](lib/pacing.js) — airtime estimates per modem preset and a
  token bucket that paces transmissions to the regional duty cycle, so the
  firmware never has to refuse and ARQ never mistakes legal throttling for loss
- [`lib/regions.js`](lib/regions.js) — jurisdictions as data: one row per
  firmware region with its airtime budget and legal framework; a node with
  region `UNSET` is refused, not transmitted through
- [`lib/links/meshtastic-device-link.js`](lib/links/meshtastic-device-link.js) —
  the thin binding to a real node: `@meshtastic/core` over the private
  application port, plus region and airtime-utilisation watchers
- [`lib/links/memory-mesh.js`](lib/links/memory-mesh.js) — the radio's test
  double: MTU-enforcing, lossy, duplicating, jittering

The transport-neutral sync half lives on the MIT side, in
[orbitdb-storacha-bridge](https://github.com/NiKrause/orbitdb-storacha-bridge)
(`courier-sync`, [issue #50](https://github.com/NiKrause/orbitdb-storacha-bridge/issues/50)) —
see the licence section for why that split is load-bearing.

```sh
npm test
```

runs the suites, including the composed proof
([`test/full-stack.test.js`](test/full-stack.test.js)): two OrbitDB peers
converge through courier-sync → ARQ → pacing → a mesh that drops frames, while
both libp2p nodes hold **zero connections**. Only physics is missing, and
physics is the bench:

```sh
NODE_A=<ip> NODE_B=<ip> npm run bench:goodput
```

drives the real courier between two TCP-reachable nodes and prints the gate
numbers (latency, goodput, retransmit rounds, airtime model vs. wall clock).

## Why this is a separate repository

**Licence, not taste.** [`@meshtastic/core`](https://www.npmjs.com/package/@meshtastic/core)
and `@meshtastic/transport-web-bluetooth` are **GPL-3.0-only**.
`@le-space/libp2p-webrtc-qr` is **Apache-2.0 OR MIT**, and a permissive library
that pulled GPL-3.0 into its consumers' builds would be misrepresenting its own
licence — the optional-peer-dependency pattern it uses for `ggwave` works
because ggwave is MIT.

So this repository is **GPL-3.0**, and it depends on the permissive packages
rather than the other way round. Permissive flows into copyleft; the reverse is
what fails.

One consequence stated in advance, because it is a one-way door: anything that
turns out to belong in a permissive package — the carrier-neutral framing, the
sync seam — has to be written **there** and used from here. Designing it here
and wanting it back later does not work. That is why `courier-sync` lives in
orbitdb-storacha-bridge and this repository only implements its courier
contract.

## The topology

```
phone ↔ BLE ↔ its own node ↔ LoRa ↔ peer node ↔ BLE ↔ phone / tablet
```

A browser reaches a Meshtastic node over Web Bluetooth
([`@meshtastic/transport-web-bluetooth`](https://meshtastic.org/docs/development/js/),
the only transport that fits a phone). One BLE client per node is a firmware
rule, so each side brings its own. Chrome/Edge on Android and desktop; no iOS,
no Firefox; the page must be foreground with the screen on.

## What LoRa does and does not do

**For the handshake: it carries the handshake, not the connection.** WebRTC
still needs an IP path between the peers — the same Wi-Fi, or both online with
NAT traversal working. Two peers linked only by mesh will verify each other's
signatures perfectly and never connect.

**For the data plane, that sentence gets its counterpart:** where no IP path
exists, the mesh carries the database itself — at radio pace. ~230-byte
packets, roughly a kilobit per second on the default preset, and in the EU a
10 % duty cycle (6 minutes of airtime per hour, enforced by the node's
firmware). Text and content IDs travel by radio; bytes travel via Storacha
when one side has internet. A photo does not fit through this pipe, and the
design does not pretend otherwise.

## The gates before the build

Signalling (from #161, unchanged): handshake time over one hop; whether
`watchAdvertisements()` works without a Chrome flag; whether a node refuses or
evicts a second BLE client.

Data plane (issue #1): single-entry latency (target: seconds to low tens) and
the ten-entry bootstrap — **over ~10 minutes on a quiet channel, live sync
loses to the pointer-CID mode**. The bench script above and the demo's sync
pane exist to answer these on hardware.

## Trademark

Meshtastic is a trademark of its owners. This project is not affiliated with or
endorsed by them; it *works with* Meshtastic devices and is named to say so.
Commercial use of the Meshtastic firmware and marks carries their own terms in
addition to the GPLv3.

## Licence

GPL-3.0-only. See [LICENSE](LICENSE).
