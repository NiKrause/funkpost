<!-- SPDX-License-Identifier: GPL-3.0-only -->

# The signalling plane

Status: **designed, **not built****

## The signalling plane — designed, not built

The plane this repository was originally named for — it began life as
`libp2p-webrtc-qr-meshtastic`, before the data plane existed and the courier
turned out to be the constant worth naming. WebRTC's offer and answer travel
as small signed payloads between two Meshtastic nodes, so the
[libp2p-webrtc-qr](https://github.com/NiKrause/libp2p-webrtc-qr) handshake
needs no camera, no messenger and no speaker — and works through walls and
across floors, to a counter with nobody standing at it. The full design —
topologies, the unattended endpoint, the guest-node turnstile, the security
analysis — lives in
[libp2p-webrtc-qr#161](https://github.com/NiKrause/libp2p-webrtc-qr/issues/161).

What it will **not** do, said louder than anything else because this plane
invites the misreading: **LoRa carries the handshake, not the connection.**
WebRTC still needs an IP path between the peers — the same Wi-Fi, or both
online with NAT traversal working. Two peers linked only by mesh verify each
other's signatures perfectly and never connect. That case is exactly what the
data plane above exists for.

Three questions gate the build, answerable on hardware, two of them able to
end the idea (from #161):

1. **How long does one handshake take over a single hop?** Compact offer plus
   answer, LongFast, quiet channel. The estimate is 15–45 s; minutes would
   kill the in-the-room case and leave only long range.
2. **Does `watchAdvertisements()` work without a Chrome flag?** Decides
   whether a waiting phone listens for a free BLE slot or falls back to
   jittered polling.
3. **Does a node refuse a second BLE client, or evict the first?** The
   failure mode decides how a shared guest node behaves when somebody taps at
   the wrong moment.

It asks for the compact (v3) payload explicitly — ~284 bytes is two LoRa
packets where a full SDP is five or six — and when it is built, it rides the
byte courier below: its offer and answer are just another payload.

---

← [funkpost](../README.md) · [ROADMAP](../ROADMAP.md)
