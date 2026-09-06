<!-- SPDX-License-Identifier: GPL-3.0-only -->

# Field notes

Status: **a running log — every entry cost a bench session**

## Field notes

Specifics learned building this on real hardware — so the next person doesn't
lose the same afternoon.

**Meshtastic over Web Bluetooth**
- The config stream (region, channels, node info) is sent once on connect and
  never replays — subscribe to every event *before* calling `configure()`, or
  a fast link races past it and shows no channels.
- Read the region *continuously*, not once: a node that just rebooted (e.g.
  after a channel import) reports its region a beat late, and a one-shot read
  freezes on the transient `UNSET`.
- `sendPacket` defaults `wantAck: true` for a reason — the client's send queue
  resolves only on a routing ACK, and a broadcast earns the firmware's implicit
  ACK only with `wantAck`. Send with `wantAck: false` and every call hangs
  ~60 s, then times out with no visible reason.
- Importing a shared channel URL reboots the node (BLE drops for a few seconds)
  and commonly resets the LoRa **region to UNSET** — re-check the region after
  every import.
- One BLE client per node: fully stop the official Meshtastic app (it reclaims
  the slot) before connecting from a browser.
- Under load — a multi-fragment send like the bootstrap blocks — a phone drops
  the GATT link: a write and a notification-triggered read overlap, one fails
  with *GATT Operation failed for unknown reason*, and
  `@meshtastic/transport-web-bluetooth` treats that single failed op as a fatal
  `DeviceDisconnected` (re-thrown, so it also surfaces as an unhandled
  rejection) — though the link is usually still alive. Don't trust one op:
  hold the `BluetoothDevice` yourself (request it by the Meshtastic service
  UUID), `createFromDevice()` again on a drop with **no chooser**, rebind the
  link to the fresh device, and re-announce so the ARQ re-sends what the drop
  interrupted. Pacing inter-frame BLE writes helps but does not remove it.

**Phones and foldables**
- `navigator.userAgentData.mobile` is **`false`** on an unfolded Samsung Fold
  and on Android tablets — battery devices that still sleep the screen (and
  pause Web Bluetooth) under you. Don't gate mobile-only UI (a wake-lock
  toggle, say) on `mobile` alone; also test the UA for `Android|iPhone|iPad`.
  And `userAgentData?.mobile ?? fallback` is a trap: `??` keeps a `false`, so
  the fallback never runs.

**Browser build (Vite + `@meshtastic/core`)**
- `@meshtastic/core` bundles tslog's Node build, which calls
  `util.formatWithOptions` and `util.types.isNativeError`; the stock browser
  `util` polyfill has neither, so the first log line throws. Shim `util` — see
  [`examples/mesh-todo/src/shims/node-util.js`](../examples/mesh-todo/src/shims/node-util.js).
- Node builtins to polyfill: `events`, `os`, `path`, `util`, `buffer`,
  `process` (via `vite-plugin-node-polyfills`).

**OrbitDB / Helia in the browser**
- Pin `blockstore-core@^5` / `datastore-core@^10` — v7/v12 implement a newer
  `interface-*` than Helia 5 expects, and the mismatch surfaces as
  `CBOR decode error: data to decode must be a Uint8Array` deep in pinning.
- Open every database with `sync: false` on a pubsub-less libp2p, or OrbitDB's
  Sync crashes on start.

**Known open**
- Desktop Chrome runs the whole path cleanly. On phones the connection now
  works — the node connects, the region live-updates, invite and announce
  cross the air both ways — and the earlier drop is understood: it is the
  GATT-op overlap above, hit hardest during the bootstrap blocks. funkpost now
  reconnects and resumes automatically, so a drop becomes a hiccup rather than
  the end of the run. How reliably a full sync completes through repeated
  drops on a given phone is the open hardware question; for a guaranteed
  two-node bench, run both ends in desktop Chrome (two tabs, one node each).

**Upstream references**
- Android/Samsung BLE quirks:
  [Meshtastic-Android#3361](https://github.com/meshtastic/Meshtastic-Android/issues/3361),
  [firmware#6958](https://github.com/meshtastic/firmware/issues/6958)
  (the developer-options toggle *Show unsupported Bluetooth LE devices* helps
  when a recent Samsung never lists the node at all — a separate symptom from
  the connection drop above).
- JS client: [meshtastic/js](https://github.com/meshtastic/js); reference
  behaviour: the official [client.meshtastic.org](https://client.meshtastic.org).
- Web Bluetooth support and spec:
  [WebBluetoothCG/web-bluetooth](https://github.com/WebBluetoothCG/web-bluetooth).

## The first booking, and the two hours before it

**6 September 2026.** A booking crossed a real mesh: the shop's rules reached a
device that had never seen them and became fourteen days of slots; the booking
crossed back and stood in the shop's day plan **31 s** later. The whole session
cost **9.3 s of airtime** — 2.5 % of the hourly allowance, on `LONG_FAST`.

What it cost to get there is the part worth writing down, because none of it
was code.

**Two nodes with the same key still heard nothing.** Both carried `le-space.de`
⌗3dd3 and transmitted on it. But the frequency slot is derived from the
**primary** channel's name while `channel_num` is 0, and one node had a
regional mesh as primary while the other had the factory default. Same key,
different frequency, `←0` on both — and *not one undecryptable packet*, which
is the tell: a key mismatch delivers unreadable packets, a slot mismatch
delivers nothing at all.

**Two browser tabs took the same node.** Both reported `!f6fd6c20`, so one
radio was talking to itself through two couriers. Nothing in the UI said so;
the node id had to be read and compared. Worth a glance before every bench:
two tabs, two different node ids.

**A remote click cannot open the Bluetooth chooser.** Web Bluetooth needs
transient user activation, and a synthetic click does not carry it. Any
automated bench still needs a human for exactly two clicks.

**What the run surfaced, in #73:** the console logged **87 `MAX_RETRANSMIT`**
errors where the app showed 4 — absorbed, but possibly provoked, since we send
broadcasts with `want_ack` and nothing rebroadcasts on a two-node bench. Two
payloads were dropped after 2 rounds. And the store reported
`Unexpected end of array` on a **brand-new** room, twice.

## Authorisation, measured rather than assumed

Asked whether anyone on the mesh could flood a salon's calendar. They can, and
it is not marginal: a neighbour with no key, no capability and no invitation
took **516 of 516 slots** across the default three-week horizon and superseded
the real customer's confirmed booking. Nothing was bypassed — a booking request
carries no signature, and a forged one may claim any timestamp, which
arbitration correctly honours.

`mesh-todo` is the same from the other side: `write: ["*"]`, with the address
broadcast in an invite.

The lesson is about the shape of the argument, not the code. The source justified
unsigned requests with "forging one only creates a booking, which anyone in radio
range can already do" — true, and the conclusion drawn from it was too generous.
*Creating a booking* and *taking every slot for three weeks* are not the same
act, and the sentence hid the difference. Recorded in
[#55](https://github.com/NiKrause/funkpost/issues/55).

---

← [funkpost](../README.md) · [ROADMAP](../ROADMAP.md)
