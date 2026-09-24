<!-- SPDX-License-Identifier: GPL-3.0-only -->

# Field notes

Status: **a running log — every entry cost a bench session**

The next session's runs are on the [run sheet](run-sheet.md); what they find
lands here.

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

## A list over the radio, with nobody's internet on

**24 September 2026, evening.** Not Run C — that one is the cold join, and both
phones already held the list, so it remains unrun. This was its neighbour and a
prerequisite for it: **both devices offline**, a change made on one, and the
data crossing on LoRa alone. It crossed, and what crossed was not the change but
the whole log.

```
20:10:53  both  internet gone
20:12:54  B     carried by the mesh — OrbitDB's own sync stopped
20:13:22  B     → announced — 1 local change offered
20:13:27  A     → announce back
20:13:30  B     → blocks 5738 B
20:22:17  A     ← blocks 5738 B
20:22:41  B     ✓ delivered after 2 rounds
```

**Eight minutes forty-seven seconds for 5738 bytes, and that is the band, not a
fault.** 5738 B is about 29 packets on `LONG_FAST`, roughly 60 s of air; at the
legal 10 % duty cycle the floor is 8–11 minutes. The measurement landed on it.
Nobody watching a phone for two minutes will believe the transfer is working,
and the app has to say so — the number is not a tuning target, it is the
carrier. The only lever left is the payload, which is what #164 measured: 5 %
of an OrbitDB entry is the todo, the other 95 % is bookkeeping.

What the run bought beyond the crossing itself:

- **The 20-minute send timeout (#163) held.** Zero `neither delivered nor
  failed` lines, zero give-ups, **one** block send where three afternoons
  earlier the same payload went three times in parallel and competed with
  itself for airtime.
- **The mesh button advised the wrong control.** It answered "switch »carry the
  list over the radio« on" four times while that switch was on; toggling it off
  and on built the path in the same second. The wiring is attempted when the
  list arrives and when the node connects, and neither had happened since both
  were last present. Fixed in #167: the button builds the path, because asking
  for it is what pressing it means.
- **"Nobody answered" was false on both phones at once**, while both kept the
  list. The window was six seconds; one hop measured 1–8 s. Also #167.
- **A 32-byte presence answer waited 8 m 51 s** behind a 5.7 KB delta in the
  same FIFO outbox — bridge issue #128. No window on the consumer side can
  repair a nine-minute answer.
- **And the delta joined nothing, three times.** The same 5738 bytes arrived at
  20:22:17, 20:30:55 and 20:38:11; `synced` never fired, no `want` was ever
  posted, and each arrival's announce drew the next copy — about eight minutes
  apart, with nobody touching either phone. Complete, joined nothing, repeat.
  The fourth round was overtaken by new writes, so whether it would have ended
  on its own is not known.
- **The delta is the log, not the change.** Two todos added at 20:38:26 are
  worth about 456 bytes; what went on the air was 6080 bytes one way and 6194
  the other — ten minutes of airtime each. `createDelta` stops its walk only at
  the peer's announced heads, so once those are not stop-points on our own
  ancestry it walks to the root and ships the whole database. Both of these are
  bridge issue #127; the open half is *why* a complete delta joined nothing.

**Half a kilobyte a minute.** Measured twice on the same evening, and the number
to plan with:

| bytes | on the air | goodput |
| --- | --- | --- |
| 5738 B | 8 m 47 s | 653 B/min |
| 6194 B | 12 m 13 s | 507 B/min |

**How to read these logs at all:** an outgoing line is stamped when the message
*starts going out*, not when it was decided. The outbox is FIFO and the carrier
is slow, so the two can be twelve minutes apart — at 20:38:43 one
`handleAnnounce` decided both a `blocks` and a `want`, and the `want` reached the
air at 20:50:56. Read an outgoing timestamp as a decision time and every
conclusion about who answered whom comes out wrong.

The offline log buffer (#156) is what makes this entry possible: none of it was
observable while it happened, and all of it was waiting when the phones came
back.

## Two days that looked like radio, and were Bluetooth

**24 September 2026.** Two Android phones, two nodes, `EU_868`. The heartbeat
had not crossed once in two days of trying, and every explanation offered
itself in turn: gossipsub, the relay, the deployment, the browser. All four
were wrong.

**The field log had never sent a line.** `shoutLog` built its payload with a
variable that does not exist, every call threw a `ReferenceError` before
reaching `publish`, and `catch {}` swallowed it. Two days of "the topic is not
audible" were a typo behind a silent catch. A catch that must not break its
caller can still `console.warn` — silence is not a requirement of being
defensive.

**The service worker blanked the page after every deploy.** The shell was
cached stale-while-revalidate, and the shell *names its bundle by content
hash*: after a deploy the cached shell asked for a file the new build had
already deleted, the request 404'd, and nothing rendered. Navigations are keyed
to `"./"`, so no cache-buster in the query could get past it. That is why a
phone showed a build from two deploys back while `curl` fetched the current one
perfectly. The shell now goes to the network first; assets keep the old
strategy, which is right for them precisely because a hashed name is immutable.

**The storm was the cause, not the consequence.** `GATT operation already in
progress` made up **502 of 925 log lines**. Three separate fixes to the
reconnect machinery moved that number by nothing, because they all work on the
reaction. Wrapping the Web Bluetooth methods showed 139 overlaps in one short
run, and in **every single one** the blocking operation was a `readValue`: the
connection sequence reads the node's configuration without awaiting each read,
nine deep before it collapses. Android Chrome allows one GATT operation at a
time; the transport reports a failed operation as a *disconnection*; everything
above spends itself repairing a link that never broke.

Serialising the operations ended it:

| | storm lines/min | overlaps | drops |
|---|---:|---:|---:|
| before | 101–114 | 133 | continuous |
| after | **0** | 3 | **0** |

Eleven log lines in two minutes where there had been hundreds. The heartbeat
crossed within the hour, both ways, with the echo.

**Then the join failed five times, and it was not the radio.** With one phone's
internet off, it tried to join **over the internet**, failed with `Failed to
load block`, and never transmitted once in four minutes — while the other
device's traffic reached it perfectly and was acknowledged after one round
each time. `carriedBy` describes what carries an *open* list, and joining is
the one moment when there is none; the switch to the mesh path returns early
without a `db`, so it could not correct itself either. Fixed by asking what can
actually fetch.

**Two lessons that are not about Bluetooth.** Measure inside the layer that
fails before touching the layer that reacts — two hypotheses (parked devices,
the supervisor itself) died on the data, and the data was one deploy away the
whole time. And a diagnostic that only works online cannot watch the run that
matters: the field log now keeps what nobody heard and sends it when somebody
does, which is how the join failure above was recovered at all.

## The first booking, and the two hours before it

**6 September 2026.** A booking crossed a real mesh: a customer's booking
travelled to the shop and stood in its day plan **31 s** later — an appointment
the shop never entered. The whole session cost **9.3 s of airtime** — 2.5 % of
the hourly allowance, on `LONG_FAST`.

**A rendered calendar is not evidence, and I reported it as if it were.** The
first write-up of this run said the shop's rules had crossed and become
fourteen days of slots on a device that had never seen them. They had not:

```js
const shop = () => ({ ...DEFAULT_SHOP, ...Object.fromEntries(shopMap.entries()) });
```

`DEFAULT_SHOP` is the base and the synced map only overrides it, so the demo
draws a full three-week grid from its own source before a single packet
arrives. What I watched was the app working offline, and I wrote it down as
reception.

The booking is the honest evidence, and it always was: the shop's day plan held
an entry the shop never made. Worth remembering as a rule — **on a link that
fails silently, only what a device could not have produced by itself counts as
proof.** Caught by the person reading the sentence, not by me writing it.

What it cost to get there is the rest, because none of it was code.

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

## A list back on a phone that never had it

**21 September 2026.** A Galaxy Fold 5 made a list on
[the recovery page](https://nikrause.github.io/funkpost/recovery/), backed it
up — the list as a CAR to Aleph, a pointer under a name the key derives — and
was reset. A Galaxy A57 with the same YubiKey showed the same DID and
signing-key fingerprints, brought the list back with the key alone, and wrote an
entry the list accepted. P11's gate, on hardware
([#93](https://github.com/NiKrause/funkpost/issues/93#issuecomment-5765768993)).

The first run on the phones failed, and so did the next thing behind it. None
of the three failures had been reached by a test:

- **The third touch threw.** `WebAuthn signing error: Cannot read properties of
  undefined (reading 'substring')`, after the key had already signed. The
  provider wants the credential id as text as well as bytes; restore handed
  out the bytes, under the text's name, and a debug line read the missing text.
- **Then "Not started"**, found by the browser test written for the first
  failure. Helia 7's `createHelia()` does not start the node, and an `await` in
  front of it looks as if it did. The page never started its node, so the first
  block OrbitDB stored failed. `mesh-todo` composes and starts its node; the
  recovery page now does the same.
- **Restore would have asked the wrong gateways.** The backup goes to Aleph;
  restore asked Storacha's two gateways first and Aleph's not at all.

All three were fixed in #117, the first also in the provider (0.7.0). The
second run on the phones worked.

**Kept for next time:** a page goes to the bench only after its whole path has
run in a browser test. Here that is a Chromium virtual authenticator with PRF,
which reproduced the phones' exception line for line before the fix and passes
after it, on every PR.

Not settled by this run: whether the backup is *kept* — Aleph's keyless upload
is ingest, not persistence, and the pointer asks for 30 days from an endpoint
whose retention is unmeasured — and the timings, which were not recorded.

---

← [funkpost](../README.md) · [ROADMAP](../ROADMAP.md)
