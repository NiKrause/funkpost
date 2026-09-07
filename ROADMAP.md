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
| **#68** | The founding off the radio | **P9, half built** — the pointer it was waiting for already existed, and the bundle that blocked it is fixed ([bridge#59](https://github.com/NiKrause/orbitdb-storacha-bridge/pull/59): +12 kB instead of +617). What is left is this side: the pointer message and its UI. |

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
([bridge#56](https://github.com/NiKrause/orbitdb-storacha-bridge/pull/56)) lives
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

**That seam is built** — [bridge#59](https://github.com/NiKrause/orbitdb-storacha-bridge/pull/59),
closing [bridge#58](https://github.com/NiKrause/orbitdb-storacha-bridge/issues/58).
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
