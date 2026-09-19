<!-- SPDX-License-Identifier: GPL-3.0-only -->

# Roadmap

funkpost carries bytes over a LoRa mesh. Above it sit **planes** — ways of
turning an application's state into those bytes — and the point of the project
is that the plane and the courier are separable. There are two planes now:

```
  app
  ────────────────────────────────────────────────────────────
  database plane: courier-sync (OrbitDB) │ event plane: rules in Yjs + a claim log
                        #1               │        #36
  ────────────────────────────────────────────────────────────
  funkpost byte courier — framing · selective-ACK ARQ · duty-cycle pacing
  ────────────────────────────────────────────────────────────
  link — Web Bluetooth → Meshtastic node  │  in-memory mesh (tests)
```

The courier does not change when a plane is added. That is the claim this
roadmap is built to keep testing.

## Where things stand

| | Thread | State |
|---|---|---|
| **#1** | Database plane (OrbitDB) | **First over-the-air replication 2026-09-04** — two desktop browsers, two nodes, no IP path. Open: first-contact reliability on a busy public channel, and the phone Bluetooth lottery. |
| **#36** | Event plane · Yjs provider | **Built and on air** — `@le-space/funkpost/yjs`, tested to convergence under 20 % loss, and carrying a shop's rules over a real mesh on 2026-09-06. Awareness deliberately left out. [docs](docs/yjs-provider.md) |
| **#37** | Hoist demo scaffolding into the lib | **Built** — the device supervisor and the error humaniser are library code; `mesh-todo` is a consumer. Not yet re-run on hardware. [docs](docs/links.md) |
| **#38** | `mesh-calendar` demo | **Built, deployed, and one booking has crossed real hardware** (A1–A6; A7 half met). Bookings moved off the CRDT onto a claim log after #45: the greeting is 111 bytes at any number of writers, and expiry is forgetting. [docs](docs/mesh-calendar.md) |
| **#45** | Is Yjs right for bookings? | **Answered and acted on** — no, at scale, for bookings; yes for the rules. Both now sit where they belong. |
| **#55** | Authorisation | **Open, measured** — a request carries a public key and no signature, so a neighbour can take 516 of 516 slots. Deliberately not patched: the README says authorisation has not been designed, and that should stay true until it is. |
| **#75** | Reshape `mesh-todo`? | **Decided** — no. None of what made `mesh-calendar` cheap transfers; the announce is already small. A send button and `courier-sync` in-house do transfer, and are P8. |
| **#68** | The founding off the radio | **P9, half built** — the pointer it was waiting for already existed, and the bundle that blocked it is fixed ([bridge#59](https://github.com/NiKrause/orbitdb-storage-bridge/pull/59): +12 kB instead of +617). The backend that was missing now exists — Aleph, keyless upload with STORE for retention (bridge 0.5.3). What is left is this side: the pointer message and its UI. |
| **#82** | Internet first, mesh as fallback | **P10, built** — the fallback is cheaper than #82 feared, because phones that synced over IP already share the log; only the changes cross the mesh. OrbitDB's own sync and `courier-sync` carry one log **one at a time** without losing or duplicating a write; running both at once stalled, so the app switches between them and never runs both. The loss is established by a failed dial rather than a flag, the switch is a question rather than a reflex, and the app can ask the air whether another app — not another radio — is out there. |
| **#93** | A lost phone, the same passkey | **Planned, P11** — the design exists in p2pass (PRF seed → deterministic IPNS key → manifest), used as reference and not integrated. The first question is whether PRF works with a YubiKey on the two actual phones. |

Both planes stay. OrbitDB gives signed entries, an access controller and a
verifiable hash-linked history. Yjs gives tiny, loss-tolerant, order-independent
updates and a bootstrap measured in frames rather than kilobytes. **Pick by what
the application needs to be true** — the tradeoff table lives in #36.

## Phases

Ordered so that every phase is testable when it lands, and nothing waits on
hardware that does not have to.

### P0 · Error humaniser into the lib — #37 B ✅

Names now come from the **firmware enum** rather than a hand-copied table, so a
code this build does not know degrades to `"routing 41"` instead of `undefined`.

*Gate met:* `routingErrorName(5) === "MAX_RETRANSMIT"`; the hand-copied map is
gone from `App.svelte`.

### P1 · Yjs provider core — #36 S1–S2 ✅

`createYjsProvider` over `courier.send` / `courier.onPayload`. Built on **core
Yjs only** — no y-protocols, no lib0 — because state vectors and diffs are the
whole vocabulary needed. Plus the adaptations the radio forces: coalescing local
edits into one payload, echo suppression, `resync()`.

Two scope notes against the original plan: **awareness was dropped**, not
deferred within S2 — it is built for WebSocket cadence and would spend the
entire duty-cycle budget announcing who is looking at the document. And the
provider takes **any** `{ send, onPayload }`, so it is reusable outside this
repository; a test runs it with no framing, ARQ or radio to keep that honest.

*Gate met:* two docs converge across a 20 % frame-loss run with no manual
retries; a ten-keystroke burst produces **one** payload. No hardware needed.

### P2 · Reconnect supervisor into the lib — #37 A ✅

`connectMeshtasticDevice` holds the device-lifecycle state machine —
subscribe-before-configure, the generation guard, teardown-first reconnect,
exponential backoff, the stability timer, the give-up cap, `link.rebind`. The
transport stays the caller's business: it asks for a `createDevice` factory and
imports no transport itself, so it works over TCP or serial too.

*Gate met:* each clause is asserted against a stub `MeshDevice` with injected
disconnects; `mesh-todo` is repointed and its BLE branch lost ~100 lines. Caveat
worth keeping visible: the e2e suite runs the BroadcastChannel fake, so the
**BLE path is unit-tested, not yet re-confirmed on hardware** — that is P7's
job, and the next field run should watch for it.

### P3 · mesh-calendar core — #38 A1–A3 ✅

The document model, the slot engine (rules → grid, never enumerations), the busy
mask, capability keys, and the deterministic arbitration that makes two
customers racing for one slot resolve identically on both sides **without
exchanging a packet**.

Measured, rather than asserted: three weeks of availability travel as **422
bytes of rules** (516 slots would have been kilobytes), and busy time as a
**72-byte** bitmap — one frame, the same size empty or full.

*Gate met:* 200 shuffles of twelve contested claims give one identical verdict,
and so do three Yjs replicas fed the same updates in different orders. Over a
20 %-loss mesh two customers race for one slot: both sides name the same winner,
the loser is told why and offered alternatives, and the payload counter **does
not move** while arbitration happens.

Two bugs the tests caught and the code would not have shown: a `Y.Map` is not an
`instanceof Map`, so decisions were silently never read — invisible in auto mode,
which never consults them; and a comparator read the decision timestamp off the
claim instead of the decision, falling through to the id. Deterministic, but the
wrong policy.

Deliberately deferred and written down rather than forgotten: **document
compaction** (a salon books for years and Yjs keeps history) and the fact that
changing `slotMinutes` shifts the whole grid index space.

### P4 · `.ics` and the serverless Calendly link — #38 A4 ◐

Generator with folding counted in **octets** (not characters, and never
splitting a multi-byte character), TEXT escaping in the order that does not
double-escape, stable `UID` with a rising `SEQUENCE` so a change replaces rather
than duplicates, and `METHOD:CANCEL` for a withdrawal. Times in UTC, so no
`VTIMEZONE` ships. The customer's file carries the capability link; the salon's
does not.

*Gate half met:* structure is proven in CI — every line ≤ 75 octets, CRLF
throughout, a full parse-back round trip, and a real booking round-tripping to a
cancel whose signature verifies. **Import into Apple Calendar, Google Calendar
and Thunderbird is a manual check and has not been done**; until it has, treat
this phase as open.

### P5 · The two UIs — #38 A5 ✅

Customer booking flow and salon day view, the Rückfrage popup, the mode switch,
and the collapsible radio strip that keeps the transport honest.

*Gate met:* five Playwright runs over the fake mesh — the full script (ask →
approve → converge → download → parse, with every `.ics` line checked to be
inside 75 octets), auto-confirm without the salon acting, occupancy blocking the
times a service really covers, a decline genuinely freeing the slot, and the
whole thing again over a mesh dropping a fifth of all frames.

Two things the browser found that the unit tests could not: the view was
computed *after* the template was told it was ready, which is a crash rather
than a flicker; and a BroadcastChannel does not cross browser contexts, so
isolating the two roles the way two real phones are isolated cut the very wire
under test. Local storage is namespaced by role instead.

### P6 · Deploy both demos, and make the link work — #38 A6 ✅

`pages.yml` builds both, each demo under its own name: `/funkpost/mesh-todo/`
and `/funkpost/mesh-calendar/`, the latter matching `DEFAULT_BASE` in
`link.js`. The booking demo started at `/funkpost/termine/`, and because every
`.ics` ever downloaded points at whatever that constant said at the time, the
old path stays for good as a fragment-preserving redirect. **A path this app
has issued links from can be left, never deleted.**

The link is now also *read*, which it was not: opening `#/b/<shop>/<booking>/
<token>` adopts the capability and fetches the booking over the mesh, so a
calendar entry opens on a phone that has never seen the book — and can cancel
from there, because the token is a key rather than a lookup. A service worker
keeps the shell, so that works with no network at all.

*Gate met:* eight e2e runs, including the link opening on a wiped device and
cancelling from it, a foreign fragment being ignored rather than obeyed, and a
reload with the network switched off.

Three bugs the browser found that nothing else would have:

- **The claim sync never greeted on start.** A peer joining a room with an empty
  log waited in silence for ever — which is precisely what a calendar link is.
  Earlier tests passed only because the other side happened to publish.
- **The service worker registration hung off `load`**, an event that has usually
  already fired by the time a module runs.
- **The Cache API honours `Vary`, and the server answers `Vary: Origin`.** Every
  lookup missed while the cache visibly held exactly the right URLs.

Also fixed on the way: the salon's agenda kept a customer's name on a slot that
a cancellation had freed.

### P7 · Hardware bench — #38 A7 ◐

Two nodes, EU_868, both booking modes. Round-trip latency, measured airtime per
booking, a confirmed end-to-end booking with an `.ics` on both phones — recorded
in the README the way the first replication was.

*Gate half met (2026-09-06).* Two nodes, `LONG_FAST`, both on `le-space.de`
⌗3dd3 with the same primary channel, no IP path: a customer's booking travelled
to the shop and stood in its day plan **31 s** later — an appointment the shop
never entered. The whole session cost **9.3 s of airtime** — 2.5 % of the
hourly allowance.

**What the gate still wants:** the Rückfrage mode (a human decision crossing the
mesh, which auto mode never exercises — nobody signs in auto mode, so no
decision record travels), and an `.ics` on both phones. What the run surfaced
instead is in #73: `want_ack` on broadcasts may be tripling our airtime, two
payloads were dropped after 2 rounds, and the store errors on an empty room.

### P8 · The change, not the founding — #75

`mesh-todo` keeps OrbitDB; #75 records why reshaping it would buy nothing. Two
things it *does* take from `mesh-calendar`, in order:

**P8a · A manual send button.** ✅ Correcting the phase as first written: the
timer in `courier-sync` only runs while a joiner has no database yet — a
bootstrap retry, not a heartbeat, and well judged. What actually announces
eagerly is **every local write**, and that is what the button replaces.

The saving is not the announce, which is one small message. It is what follows:
the peer wants, blocks come back. Five writes become five of those round trips
where one would carry all five, since `createDelta` walks from the heads down
to theirs.

*Was blocked on a release, not on code.* The option to opt out
([bridge#56](https://github.com/NiKrause/orbitdb-storage-bridge/pull/56)) lives
in a permissive package, as P8b requires — and `courier-sync` had never been
published to npm: it landed after v0.4.3, so this repository depended on
`github:…#main` rather than a version. **`orbitdb-storacha-bridge` 0.5.0 fixed
that**, and both `package.json`s now name a version.

Worth saying why that mattered, since at the moment of pinning the branch and
the tag were the same commit and nothing about the build changed: a `#main`
dependency is not a version that happens to be current, it is *whatever main
says when someone next installs*. The pin does not correct today's build. It is
what makes tomorrow's the same one.

*Gate met:* nothing leaves the radio until pressed — `mesh-todo`'s e2e suite
runs ten cases including "changes wait for the button, and then they cross",
which watches an idle app stay silent and the delta arrive once it is pressed.
And funkpost depends on a version, not a branch.

**P8b · `courier-sync` out of the backup project — but not into this one.**
566 lines importing only `multiformats` and `@ipld/dag-cbor`; nothing in it is
Storacha, so it is a clean seam sitting in a repository whose purpose is
something else, where every duty-cycle-driven change is a foreign body.

The obvious move — copy it here — is **the one thing this repository must not
do**, and it is written down: funkpost is GPL-3.0 because `@meshtastic/core` is,
`courier-sync` is permissive, and permissive flows into copyleft while the
reverse fails. Anything that belongs in a permissive package has to be written
*there* ([why-separate-repository.md](docs/why-separate-repository.md)). Copying
it here would quietly make it GPL and close that door for good.

So: **its own permissive package**, depended on from here exactly as today.
That buys the independence without spending the licence. *Gate:* `mesh-todo`
builds and its e2e suite passes against the new package, the OrbitDB plane gets
its own tests wherever the code lands, and `why-separate-repository.md` still
reads true afterwards.

**Not in this phase, on purpose:** first contact. Bob without the database costs
~2 KB, inherent to a hash-linked log, and that belongs off the radio the same
way the app bundle does — Wi-Fi, a QR, or a pointer (#68). *The mesh carries the
change, not the founding.*

### P9 · The founding, off the radio — #68

P8 ends by naming what it deliberately does not fix: Bob without the database
costs ~2 KB, inherent to a hash-linked log, and *the mesh carries the change,
not the founding*. This is the phase that gives "the founding" somewhere else
to arrive from.

**The shape.** Alice backs up to Storacha whenever she next has internet and
beams **one CID** over the mesh. Bob restores from that CID whenever *he* next
has internet — from a public IPFS gateway, with no Storacha credentials of his
own. After that, only deltas ever use the radio. One database, two couriers,
each doing what its physics allows.

**Measured, not estimated.** A pointer message — version, tag, database address
and CID, dag-cbor encoded — is **147 bytes**. The frame payload is 191 bytes at
the default 200-byte MTU, so that is **one frame**. Today's first contact is
~2 KB, gzipped to ~1.2 KB, which is **about seven**. Seven frames to one.

**Half of it already exists, and #68 does not know that.** The issue says it
waits on "the planned latest-backup pointer (v0.4.4)". That pointer is moot:
`backupDatabaseCAR` already returns a `metadataCID`, and `restoreFromSpaceCAR`
already accepts one — resolving the blocks CAR out of the metadata and fetching
both from the IPFS network or one of four public gateways. **The restoring side
needs no credentials.** That is the whole mechanism, built and shipped.

**The obstacle it also does not know about is the bundle.** `backup-car.js`
imports from `orbitdb-storacha-bridge.js`, which imports `@storacha/client` at
module level — so a restore-only client pays for the entire backup SDK:

| | gzipped |
|---|---|
| `mesh-todo` today | 561 kB |
| … importing `restoreFromSpaceCAR` as it stands | **+617 kB** |
| … importing `restoreFromCID` instead | **+12 kB** |

It would **more than double the application** to save six frames.

*These three were measured on OrbitDB 3 / Helia 5.* On OrbitDB 4 / Helia 7
`mesh-todo` itself is **420 kB**, because it composes a light Helia instead of
calling `createHelia`, which would pull in Helia's whole default libp2p stack
(718 kB). **Re-measured on the new stack 2026-09-18: importing `restoreFromCID`
costs +3.8 kB gzipped** (420.4 → 424.2), not the 12 kB of the old one — the gate
asks for under 20.

**That seam is built** — [bridge#59](https://github.com/NiKrause/orbitdb-storage-bridge/pull/59),
closing [bridge#58](https://github.com/NiKrause/orbitdb-storage-bridge/issues/58).
It lives there and not here for exactly P8b's reason: it is permissive, this is
GPL, and anything that should stay permissive has to be written *there*
([why-separate-repository.md](docs/why-separate-repository.md)). funkpost's own
share is the pointer message and the UI around it.

The 12 kB is measured against that module rather than estimated from its
dependencies, and the difference matters more than the number: an earlier
reading said 27 kB, which was an artefact of importing it by absolute path so
that Vite resolved `multiformats` and `@ipld/car` twice, once out of each
project. A bundle measurement that does not share a dependency tree with its
consumer measures the wrong thing.

**One sentence has to change, rather than quietly stop being true.**
`examples/mesh-todo/src/stack.js` says *"Every replicated byte travels through
the courier or not at all."* With a pointer it does not: the courier carries
every **change**, and the founding may arrive by CID over plain HTTPS. Rewrite
the claim with the mechanism.

**What this does not do.** If neither side ever touches the internet, nothing
changes and the mesh carries the founding exactly as today. The pointer is an
optimisation available when somebody touches the internet — not a replacement,
and not a dependency.

*Gate:* a pointer crosses in **one** frame, counted rather than estimated; Bob
restores a database he has never seen from the CID alone, with no Storacha
credentials, while the radio carries nothing but that pointer; `mesh-todo`'s
bundle grows by **under 20 kB gzipped**; and `stack.js`'s claim about where
bytes travel reads true against the code again.

*Step 1 (2026-09-18):* the message exists and both numbers are counted.
`lib/founding-pointer.js` encodes version, tag, address and CID as dag-cbor:
**145 bytes, one frame** at the default 200-byte MTU, against about seven for
today's first contact. The seam costs **+3.8 kB gzipped**. What is left is the
wiring — backing up when there is internet, restoring on the far side, and the
UI around both — and the backup half needs the browser fix released in
orbitdb-storage-bridge 0.8.0, since every backup here happens in a browser.

### P10 · Internet first, the mesh when it is gone — #82

**Built.** `mesh-todo` was mesh-only on purpose —
`addresses: { listen: [] }` and `sync: false` — and the relay-synced version
was a different program, `simple-todo`. #82 wrote the question down and left it
unscheduled. This phase scheduled it, and the app now carries one list over
either path.

The demo: two phones keep a list in step over the internet, as any OrbitDB app
does. The internet goes. The app notices, **says so**, offers the LoRa mesh,
proves another *app* is listening on it, and offers to send what changed.

**Why it is more tractable than #82 feared.** #82 worried that a fallback
carries the same data over the radio, slowly — the bootstrap alone is about
seven frames. But in a fallback the phones were syncing over IP until the
outage, so **they already share the log**: the founding happened while the
internet worked. What the mesh has to carry is only what changed during the
outage — P8's motto, *the change, not the founding*. And P8a's send button
already *is* "offer to send what changed".

In order, and the first is the risk:

1. **Both syncs on one log.** ✅ *Answered in Node, 2026-09-16.* OrbitDB's own
   replication over libp2p and `courier-sync`'s `joinEntry` writing into the
   same hash-linked log. If they fight, the design changes — so this came
   before any UI.

   **They compose one at a time, and fight when run together.**
   [`test/fallback-one-log.test.js`](test/fallback-one-log.test.js) carries a
   list over IP, then over a lossy fake mesh with IP cut, then over IP again:
   the logs end identical, every write in them exactly once, and an entry both
   sides changed while apart resolves the same way on both. Under load, with
   both sides writing in parallel:

   | carried by | runs clean |
   |---|---|
   | IP alone | 3 of 3 |
   | IP → the mesh alone → IP, sending while the other side writes | 8 of 8 |
   | IP and `courier-sync` **at the same time** | **0 of 3** — every run stalled |

   In the stalled runs a join waited out OrbitDB's 30-second block timeout for
   an identity block the other peer held and bitswap did not deliver. Not
   pursued further, because the answer does not need it: **one path at a
   time, enforced in code.** Going to the mesh stops OrbitDB's sync
   (`db.sync.stop()`) before `courier-sync` starts; coming back stops
   `courier-sync` before `db.sync.start()`. Connectivity alone must not decide
   it — detection (step 3) can be late, and a late switch is exactly the
   overlap that stalled.

   *Still open from the original gate:* the same script as an e2e in the
   browser, which needs step 2's IP path first.
2. **An IP path in `mesh-todo`** ✅ *Built 2026-09-18.* A relay, pubsub, WebRTC
   and `sync: true`, as `simple-todo` does — `createDatabaseStack({ internet })`,
   off by default under `?mesh=bc` so the e2e suite stays a closed room. Relay
   addresses come from the registry on Aleph rather than the source, since the
   one written into `mesh-todo`'s ancestors had been dead for months.

   **The switch enforces step 1's finding in code:** `carryOverInternet` stops
   the courier before starting OrbitDB's sync, `carryOverMesh` the reverse.
   Never both on one log.

   Seen in two tabs: both say *carried by the internet · 2 peers over IP*, a
   write in one appears in the other **with nothing pressed**; after both
   switch, a write **waits** for the send button and then crosses the mesh.
   The page's entry graph grows **420.4 → 462.1 kB gzipped** (+23.1) for the
   whole IP path.

   `stack.js` no longer claims every replicated byte travels through the
   courier — it says what is true now: two paths, one log, one at a time.

   *One gotcha worth the note:* a relay announces one libp2p protocol per
   database it holds open, and libp2p rejects an identify response over 8192
   bytes **whole** — so a busy relay is never recognised as a relay at the
   default limit (measured: 611 protocols). `identify({ maxMessageSize })` is
   not optional here.
3. **Detection that is honest.** ✅ *Built 2026-09-18.* Not `navigator.onLine`,
   which reports the interface and not reachability — a captive portal is
   "online" and reaches nobody. `watchInternet()` looks at what matters: are
   there open libp2p connections, and if there are none, **does a dial to a
   relay still get through**. A dropped connection alone says nothing, because
   libp2p drops and redials all the time; the failed dial is the evidence, and
   the page says which one it has: *"internet gone — no peer answers, and a
   dial to the relay failed too"*.
4. **A prompt, not a switch.** ✅ *Built 2026-09-18.* *"The peer-to-peer
   connection dropped — probably the internet. Continue over the LoRa mesh?"*
   The page never moves the log by itself: the radio spends a rationed budget,
   Web Bluetooth needs a gesture to pair anyway, and a late automatic switch is
   exactly the overlap step 1 found stalls. Until somebody answers, the log
   stays on the path it was on, and the line under it says *internet gone*.

   **Both proven in the browser, and this closes step 1's open gate.**
   [`e2e/internet-path.spec.js`](examples/mesh-todo/e2e/internet-path.spec.js)
   runs the whole script on one machine: two pages sync over a libp2p relay
   Playwright starts on `127.0.0.1` (a write appears in the other page with
   nothing pressed), the context goes offline, the page says the internet is
   gone and asks, both readers accept, and the next change waits for the send
   button and crosses the fake mesh. A second test lies to the page —
   `navigator.onLine` forced to `false` while every peer is reachable — and no
   offer appears. Nothing in the run may leave the machine: any request to
   another host fails the test.

   **What the e2e found in the app, not in itself:** libp2p 3 has no
   auto-dialer left. A discovery module files the addresses it hears in the
   peer store and dispatches an event; **nothing dials**. So the two pages met
   on the relay's discovery topic, learned each other's addresses, and never
   connected — `mesh-todo` now dials what it discovers, and retries on a
   ticker, because `peer:discovery` fires once per peer while a dial can fail
   for a while (`simple-todo` has the same subsystem, which is why it was not
   missing there). A deployed relay hides this: it opens the databases it
   hears about, so heads travel through the relay even when the peers never
   meet. A bare relay does not, and neither does a village.

   The page's entry graph is **463.9 kB gzipped** — +1.8 on step 2, for the
   watcher, the offer and the dialling.

   *One gotcha for whoever writes the next such test:* Playwright's offline
   switch is the browser's network stack, and **WebRTC does not go through
   it** — two tabs of one browser keep their direct link across the "outage",
   and then nothing has been taken away to detect. The run starts Chromium
   with `--force-webrtc-ip-handling-policy=disable_non_proxied_udp`, which
   leaves WebRTC without host candidates: as close as one machine gets to two
   villages.
5. **A connection test with peers, not radios.** ✅ *Built 2026-09-19.*
   `mesh-todo` lists the radio *nodes* its node has heard, and on a public
   channel most of them are somebody's router. That proves radios are in range
   — not that another `mesh-todo` is keeping this list, which is the question
   worth a rationed budget.

   Answering it needs the protocol, so it was written in the bridge, for P8b's
   reason: [bridge#99](https://github.com/NiKrause/orbitdb-storage-bridge/pull/99),
   released as **0.9.0**. Every `courier-sync` message now carries a four-byte
   sender id, so ordinary traffic answers the question for free — a sync round
   *is* the proof — and `hello()` asks outright for the silence in between.
   `presence()` reports who has been heard lately and how long ago the air last
   carried anything at all; `forgetPeers()` drops it when the carrier changes
   underneath, which is what a TX-channel switch does.

   **The price, counted:** the id is **7 bytes of dag-cbor on every message**,
   and asking outright is **33 bytes out, 32 back** — one frame each, against
   the seven or so a first contact costs. Airtime spent to find out whether
   spending airtime is worth it.

   Two things the bridge's tests hold down, because both would lie to somebody
   alone in a valley: **a mesh repeating our own message is not company** (LoRa
   rebroadcasts, so a node hears itself), and **a peer keeping another database
   on the same air is not either**. Its `hello` test drops everything the peer
   says until the question is asked, so the answer is the only thing that can
   prove anything.

   In the app: *Is anyone out there?* under the send button, the answer in
   plain words (*1 app out there keeping this list, last word 6 s ago* or
   *nobody answered — radios can be in range without an app listening*), and
   the question asked on its own the moment somebody accepts the mesh, which is
   exactly when it is due. An older peer sends no id and answers nothing, so it
   cannot be counted — its traffic still moves "last word", which is the honest
   degradation: somebody is out there, we cannot say who.
6. **Offer the sync** — exists, P8a.

*Gate:* the whole script on the fake mesh in e2e, then once on the two nodes.
**Half met, 2026-09-19:** the script runs in e2e —
[`internet-path.spec.js`](examples/mesh-todo/e2e/internet-path.spec.js) carries
a list over IP, loses the internet, asks, switches and sends over the mesh, and
[`mesh-todo.spec.js`](examples/mesh-todo/e2e/mesh-todo.spec.js) asks the air who
is out there and is told the truth both times. The two nodes are the open half,
and they need hardware on a bench, not another commit.

### P11 · A lost phone, the same passkey — #93

The demo: phone A holds the list and a passkey on a **YubiKey**. Phone A is
wiped. Phone B, with the same YubiKey, restores the list **with the same
identity** and can write to it — not only read it. P10 is *the internet is
gone, the mesh carries*; P11 is *the device is gone, the internet brings it
back*.

**Why the passkey matters.** An access controller that names the owner makes a
restored copy readable but not writable unless phone B reproduces the same
identity. *Restored* has to mean *same identity*, not *same bytes*. And a
YubiKey rather than a synced passkey, because then the secret is on the key and
not on the phone that was lost.

**The design exists, in [p2pass](https://github.com/Le-Space/p2pass)** — used as
reference, **not integrated**. The WebAuthn PRF seed is the root of every key;
HKDF over it gives a deterministic IPNS key, so phone B finds the pointer with
nothing from phone A; the identity archive is encrypted with the PRF key and
fetched without auth. The primitives underneath are
`@le-space/orbitdb-identity-provider-webauthn-did`, and **that is the dependency
to take**, not p2pass. Storage and restore are the bridge's (0.5.2, 0.5.3,
`restoreFromCID`).

p2pass hangs on Storacha for uploads (dead), a UCAN delegation in the manifest
(meaningless now) and `w3name` for IPNS (alive when checked, but Storacha's).
Four things it does must not come along, each detailed in #93: a **rawId
fallback** when PRF is missing, which keys a publicly fetchable archive with a
value that is not secret — and runs silently on exactly the phones that lack
PRF; a bug that **creates a new credential where reuse was meant**, giving a new
PRF seed and a recovery that resolves a name nobody published; **cross-device
recovery that was never tested**, because a virtual authenticator cannot be
shared between browser contexts; and a routing endpoint that answers **200 with
an error body**.

In order — check before design:

1. **The two phones, first.** ✅ *Answered 2026-09-19, on a Galaxy Fold 5 and a
   Galaxy A57 with one YubiKey.* PRF and a discoverable credential, on the
   hardware rather than on a virtual authenticator — because missing PRF on
   either phone changes the design, and nothing else was built before that
   answer.

   Both phones, one key, [the probe](examples/landing/passkey-probe.html)
   (published at
   [/funkpost/passkey-probe/](https://nikrause.github.io/funkpost/passkey-probe/)):

   - the **same PRF value** on both — the identity can travel by PRF, so the
     rawId fallback #93 forbids is not merely forbidden, it is unnecessary;
   - the passkey was **found without being named** — the probe never says which
     credential to use, so it is discoverable on the key, which is all phone B
     has to go on;
   - the signature is **ES256**, and two of them leave exactly one candidate
     public key ("2 from signature 1 · 2 from signature 2 · 1 in both"), so the
     **DID is recovered rather than stored**;
   - **DID, PRF and derived signing key identical on both phones.** That is the
     whole claim of the phase, measured: the same key on a second device
     reproduces the same identity, with nothing carried over.

   The values themselves stay off this page; what matters is that they matched.
2. **A pointer without `w3name`** ✅ *Measured and built 2026-09-19.* An IPNS
   record signed by a key the seed derives, published through delegated
   routing — `w3name` was Storacha's, and Storacha is gone.

   *Measured first,* because the doubt was never the code:
   `PUT /routing/v1/ipns/{name}` at `delegated-ipfs.dev` answers **200**, the
   `GET` gives the record back byte for byte and it validates against the name,
   and the preflight allows `PUT` **from any origin** — run again from a real
   browser page on a foreign origin, both calls 200. So a page with no server
   behind it can publish a pointer
   ([bridge#101](https://github.com/NiKrause/orbitdb-storage-bridge/pull/101)).

   *Then built:* `orbitdb-storage-bridge/pointer-ipns`
   ([bridge#102](https://github.com/NiKrause/orbitdb-storage-bridge/pull/102)) —
   `derivePointerKey` stretches a seed into the key, the name follows from it,
   and `resolvePointer` **validates every record against the name it asked
   for**, so an endpoint cannot hand back somebody else's pointer without being
   caught.

   *Not established, and therefore not promised:* that a record travels beyond
   the endpoint that took it (the public gateways answered 429 and 403), and
   how long it is kept.
3. **Dehydrate** on phone A ✅ *Built 2026-09-19* — and **without the encrypted
   identity archive this step used to call for**. That archive existed because
   the signing key was generated at random and had to be carried; derived from
   the passkey it does not have to be, so the step is: the database as a CAR to
   Aleph, the metadata that names it, and the pointer. One call:
   `dehydrate({ orbitdb, address, seed, backend })`
   ([bridge#103](https://github.com/NiKrause/orbitdb-storage-bridge/pull/103)).
4. **Hydrate** on phone B ✅ *Built 2026-09-19.* `hydrate({ orbitdb, seed })` —
   the same name, the record checked against it, `restoreFromCID`, the database
   open. Between the two devices there is **no CID, no address and no file**,
   only a secret both can produce. Four tests carry it end to end against a
   memory backend and a routing endpoint written in the test file: another seed
   finds nothing rather than somebody else's list, and a label keeps two
   databases of one seed apart.
5. **Write**, not just read. ✅ *Shown 2026-09-19*
   ([bridge#104](https://github.com/NiKrause/orbitdb-storage-bridge/pull/104)),
   which is what the phase turns on: a restored copy that can only be read is a
   photograph.

   A signing key derived from the same secret produces the **same identity
   document — same id, same hash** — on a machine that never saw the first. So
   the access controller that named the original writer accepts the device that
   came back: it writes, a courier carries the entry, and the original joins it.
   A device holding another key restores the same database, reads it, and is
   **refused** on write, which is what makes the acceptance mean anything.

   *Still the gate, and not claimed:* the hardware. Phone A **wiped**, not a
   cleared tab, and phone B writing with the same YubiKey. The mechanism holds;
   that is a different sentence from "it happened on the bench".

   Two traps turned up on the way, both silent, both now in the write-up:
   `Identities({ keystore })` without `ipfs` verifies only identities it minted
   itself, so a restored log comes back **empty with no error**; and seeding a
   keystore under your own label is not enough with OrbitDB's default provider,
   which looks the identity's key up under a derived hex id.

*The whole procedure is written down* — the four things that have to be true,
which package solves each, the code for both sides, and what none of it
promises:
[Getting a database back on a device that has nothing](https://github.com/NiKrause/orbitdb-storage-bridge/blob/main/docs/RECOVERY-ON-A-SECOND-DEVICE.md).

*Gate:* phone A **wiped**, not simulated by clearing a tab; phone B with the
same YubiKey restores the list, its identity equals the original, and it writes
an entry the original access controller accepts. Missing PRF produces a
refusal, never the fallback.

### Running alongside: #1 reliability

Independent of the phases above, and driven by field runs rather than a
schedule: first-contact bootstrap on a congested channel, and how reliably a
full sync survives repeated BLE drops on a given phone. The standing
recommendation for any real bench is a **private Meshtastic channel** — it
removes the congestion that causes most of it.

## Principles these phases are testing

- **The courier does not learn about its payloads.** Adding a second data plane
  must require zero changes to framing, ARQ or pacing. If P1 forces a change
  down there, the seam was wrong and that is the finding.
- **Transmit rules, not enumerations.** Availability is a couple of hundred
  bytes of rules; a slot grid is thousands of entries. The difference is the
  whole demo.
- **Convergence is not agreement.** A CRDT that merges two bookings for one slot
  has not solved the double-booking; it has only made both replicas agree that
  it happened. The arbitration in P3 is where the actual answer lives.
- **Say what does not work.** The `.ics` link needs the app shell, and the app
  shell arrives over HTTP the first time. A public channel broadcasts every
  booking to every neighbour. Both are written down, in the UI and in the docs,
  rather than discovered by whoever runs it.
