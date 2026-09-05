<!-- SPDX-License-Identifier: GPL-3.0-only -->

# The appointment core

Status: **built and tested** ([#38](https://github.com/NiKrause/funkpost/issues/38)
A1–A6) — domain, calendar file, both screens, and the deploy. Never run on
hardware (P7). Tests: `examples/mesh-appointments/test/` and `e2e/`.

Try it: **`/funkpost/termine/`**, or locally with `?mesh=bc&room=x&role=salon`
in one tab and `role=customer` in another — two tabs play the two devices with
no hardware at all.

Bookings no longer live in the CRDT: see **Two substrates** below, and
[#45](https://github.com/NiKrause/funkpost/issues/45) for the measurement that
moved them.

An appointment book for a local business, on the Yjs plane. It is the demo that
proves the plane, and it was chosen because it exercises what a lossy,
duty-cycled, high-latency link is *worst* at: contention for a scarce resource
that two people want at once.

## The two screens

One page, two roles, chosen once and remembered.

**The customer** gets a Calendly-shaped booking pane: service, a strip of open
days, and time pills. A slot is offered only if the service actually *fits* —
a 45-minute cut is refused at 17:30 on a day that shuts at 18:00, and refused
at 13:30 if 14:00 is taken, because it would run into it.

**The salon** gets the day's agenda, the mode switch, and — in Rückfrage mode —
the request as a popup with *Bestätigen* / *Ablehnen*. Its answer is signed;
the customer's device verifies it rather than taking it on trust.

Along the bottom, collapsed by default, sits the **radio strip**: frames out and
in, retransmit rounds, payloads. The product surface stays calm and the
transport stays one click away, because a demo that hides the radio is lying
about what it is.

The whole script is covered end to end in `e2e/` over the fake mesh — request,
decide, converge, download the `.ics`, parse it back and check every line is
inside 75 octets — including a run where a fifth of all frames are dropped.

## Two substrates, and why

| what | where | why |
|---|---|---|
| shop rules — hours, services, mode, the salon's public key | **Yjs** | a handful of stable devices write them, and merge genuinely helps |
| bookings — requests, decisions, cancellations | **claim log** | every customer session would be a permanent new Yjs author |

The Yjs provider greets a peer by publishing a **state vector**, and a Yjs state
vector is O(authors who have ever written) and never shrinks. Measured:

| distinct writers | state vector | frames per greeting |
|---|---|---|
| 5 | 36 B | 1 |
| 1 000 | **5 936 B** | **30** |

Deleting *every booking* leaves it at 5 936 B — the clocks must be remembered,
so client ids are permanent. Thirty frames to say hello would spend a EU-868
hour's whole duty cycle on greetings.

This is not a Yjs defect. Yjs is built for a handful of collaborators on one
document, and there it is excellent — which is exactly why the rules stayed.

The **claim log** summarises the same information as one small digest per day of
the horizon:

| | claim log |
|---|---|
| greeting | **111 bytes for three weeks — at 1, 100 or 1 000 writers** |
| grows with | the horizon, not the number of people |
| expiry | drop yesterday's bucket; no tombstones, no ids kept for ever |

Two peers who agree exchange **one frame each and fall silent**. Only days whose
fingerprints differ are ever discussed.

### The deeper reason, beyond the byte count

Two things were true of the old shape, and the second matters more:

1. **We used almost none of Yjs.** No `Y.Text`, no sequence CRDT, no concurrent
   edits to the same value — nobody ever edits anybody else's booking. It was a
   replicated *set* of immutable records.
2. **The conflict resolution was already ours.** Mutual exclusion is precisely
   what a CRDT cannot give you, so `arbitration.js` was doing the hard part
   regardless.

Add that appointments *expire* while CRDTs are built to remember, and the
substrate was carrying the easy half and fighting the rest.

**What survived the change untouched:** `arbitration.js`, `slots.js`, `mask.js`,
`capability.js`, `ics.js`, `link.js`. Every one of their tests passed unmodified
through the substrate swap, which is what "substrate-independent" was supposed
to mean when it was claimed.

### Authority is a signature now, not a convention

The old shape kept writers off each other's keys by agreement. The salon now has
an identity — its public key travels in the rules — and a **decision not signed
by that key is not a decision**. It is refused on every device, *including the
one that wrote it*, so the rule cannot be broken locally either. That is the
access control Yjs could not offer, and it costs one verification per decision.

Requests stay deliberately unsigned: forging one only creates a booking, which
anyone within radio range of a public channel can already do, and a signature
per request would double its airtime. The channel key remains the real boundary.

## Convergence is not agreement

Yjs will happily merge two bookings for 14:00. Both replicas end up
byte-identical and **double-booked**. The CRDT has not solved the conflict; it
has only made everyone agree that one exists.

The answer is a **pure function of the converged state**. Every replica sorts
the same claims by the same total order and reaches the same verdict on its
own:

```js
arbitrate({ mode, requests, decisions, cancels }) // → Map<id, { status, reason }>
```

Nothing is written to resolve a race, so resolving one cannot start another —
and **no packet crosses the air to do it**, which is the difference between a
design that works and one that only works in the demo. The test asserts exactly
that: after two customers race for one slot over a 20 %-loss mesh, both sides
name the same winner and the payload counter does not move.

Clock skew between two phones changes *which* of two near-simultaneous claims
wins. It never changes *whether* the two agree — a tie on the timestamp falls
through to the booking id, which is arbitrary but identical everywhere.

### The two modes differ in what outranks what

| | **auto** — Autobestätigung | **ask** — Rückfrage |
|---|---|---|
| who decides | time: earliest claim wins | the salon: a confirmation outranks any earlier request |
| salon must be reachable | no — books while the salon sleeps | yes |
| double-booking under partition | possible, resolved deterministically but **late** | impossible: only the salon writes confirmations |
| pending requests | none | do **not** block each other — an abandoned request must never hold a slot for ever |

That asymmetry is the whole argument for offering both, and it is why the mode
lives in the shop rules rather than in the code.

## Availability is a rule, never a list

The single most important decision here. A salon open ten hours a day has ~516
quarter-hour slots in three weeks; shipping them as data would cost kilobytes
of airtime and would have to be re-shipped whenever the horizon moved.

Shipping the **rule** — opening hours per weekday, plus closures — costs about
**420 bytes** and describes any horizon at all. Every device generates the
identical grid from it.

"Identical" is load-bearing: the grid is also the index space for the busy
mask, so two devices disagreeing about slot 400 would disagree about who is
booked. Hence `slotGrid` is pure, and the tests pin it across **daylight-saving
transitions**, where the naive answer is wrong twice a year:

- **Spring forward** — 02:00–02:59 does not exist. A slot there would book
  someone into a second that never happens, so `utcFromWall` returns `null` and
  the grid skips it.
- **Autumn** — 02:00–02:59 happens twice. The earlier instant is chosen, and
  the night is genuinely five hours long between 01:00 and 05:00.

No date library: `Intl.DateTimeFormat` already knows every zone's rules, and
asking it what the wall clock read at an instant is enough to invert the map.

## Busy time is a bitmap

A customer does not need to know *who* is booked at 14:00, only that it is
gone. Sending the salon's bookings would leak names to every neighbour on the
channel and cost bytes per booking; a bitmap costs one bit per slot regardless
of how full the day is.

Three weeks of quarter-hours ≈ **72 bytes** including a seven-byte header —
one LoRa frame, and the same size empty or full.

The mask is a **compaction, not the authority**: live requests travel as their
own entries and count the moment they merge. A mask whose horizon or length
disagrees with the grid we just generated is **discarded**, not trusted —
silently reading someone else's index space is how a customer gets booked into
a Ruhetag.

## The capability key

The `.ics` link carries a token in its fragment. The naive design makes that
token a *password* — know it, cancel the booking — which on a shared broadcast
channel is worthless: every neighbour in radio range watched the booking go
past and could replay it.

So the token is a **seed**, not a secret to be quoted. It derives an Ed25519
key pair; the booking carries only the public half, and a cancellation must be
**signed**. Overhearing a booking therefore proves nothing. The token never
crosses the air — it lives in the URL fragment, which browsers do not send
anywhere.

Pure WebCrypto (browser and Node ≥ 20): the seed is wrapped in the fixed PKCS#8
prefix and imported, and the public half is read back out of the JWK export.

**What this does not do:** make a public channel private. Everyone still *sees*
the booking. Confidentiality needs a private Meshtastic channel, and the UI
must say so.

## The records

Three immutable kinds, bucketed by the day of the slot they concern — so a whole
booking's history expires together:

| kind | authored by | proven by |
|---|---|---|
| `request` | the customer | nothing; it carries the capability's public key |
| `decision` | the salon | a signature under the salon's key |
| `cancel` | the capability holder | a signature under the booking's own key |

Merging is set union, because nothing is ever mutated. A booking carries its
**absolute start time**, not an index into whichever horizon happened to be on
screen, so it means the same thing next week and changing `slotMinutes` no
longer reinterprets the past.

Only a first name and a service id ever travel. Everything else a salon knows
about a customer belongs in a local document that is never synced — and the
busy mask exists so a customer can learn that 14:00 is gone without receiving
anybody's name at all.

## The `.ics`, and the link with no server behind it

The calendar file is the one artefact of this system that outlives the radio
session: it lands in Apple Calendar or Thunderbird and has to still be correct
months later, on a device that has never heard of LoRa. Three details are easy
to get wrong and are therefore tested rather than assumed:

- **Folding is counted in octets, not characters.** A line may not exceed 75
  octets and a multi-byte character may not be split across the fold. "Föhnen"
  and "—" are two and three octets; counting characters yields lines that look
  legal and are not.
- **TEXT escapes `\` `;` `,` and newlines, in that order** — reverse it and the
  backslashes you just inserted get escaped again. An unescaped comma silently
  truncates an address.
- **`UID` is stable and `SEQUENCE` rises.** The same UID on both sides means the
  salon and the customer hold *one* event; a rising SEQUENCE means a changed or
  cancelled booking **replaces** the earlier entry instead of appearing beside
  it. Getting this wrong is how a rescheduled appointment becomes two.

Times go out in UTC (`…Z`), so no `VTIMEZONE` is ever shipped and we are never
wrong about a zone the receiving client knows better.

The customer's file carries the change/cancel link; the **salon's does not** —
the salon holds no capability and must not publish a link implying otherwise.

### Why the link works without a backend

```
https://…/termine/#/b/<shopId>/<bookingId>/<token>
                  ^ everything from here never leaves the browser
```

A fragment is not sent to the server — not in the request line, not in a
header, not in a referrer. The capability token is therefore never disclosed to
the host, a CDN, or anything in between. Opening the link fetches **static
files only**; the change itself then travels over the mesh, signed with the key
the token derives.

Opening such a link adopts the capability and fetches the booking **over the
mesh** — so a calendar entry opens on a phone that has never seen the book, and
can be cancelled from there, because the token is a key rather than a lookup.

A service worker keeps the app shell, so all of that works with **no network at
all** — for anyone who has opened the app before, which is everybody who booked
through it.

**The sharpest edge, stated plainly:** a stranger tapping a cold link on a
device that has *never* loaded the page still needs the network once. No service
worker can change that, which is why the QR code at the counter is the
offline-native path and should be the primary one.

The deploy path is a **one-way door**: every `.ics` ever downloaded points at
it, and a calendar entry from last spring must still lead somewhere useful.

### What CI cannot prove

Structural correctness is tested — every line ≤ 75 octets, CRLF throughout, a
full parse-back round trip, `SEQUENCE` behaviour. Whether **Apple Calendar,
Google Calendar and Thunderbird** each accept the file is a manual check, and
until someone has done it on all three this gate is only half met.

## What the device keeps

Everything used to live in memory: a reload, or a phone discarding the tab, lost
the whole book — and the only way back was to greet the mesh and hope somebody
answered, which on a duty-cycled link is not a recovery strategy.

Both halves are now stored in IndexedDB, in one place and with no dependency.
`y-indexeddb` is the obvious answer and covers only half the problem: since the
substrate change the bookings are not in the Yjs document at all, so it would
faithfully persist the opening hours and lose every appointment.

The claim log is unusually easy to persist, and not by accident — records are
immutable and self-describing, so there is no migration, no merge on load, and
nothing half-written to guard against.

## Saying whether anybody is there

A digest carries four random bytes naming its sender. On a broadcast medium
there is no such thing as a connection, so *"is anybody there?"* can only be
answered by having heard from them recently — and without a name, two peers and
one chatty peer look identical. Four bytes on a message that was going out
anyway buys an honest answer to the question every user asks first.

The indicator is grey with no radio, amber when the radio is open but nobody has
been heard, green with a count when they have. It never claims company it cannot
back up.

## A booking is a fact, not a row in today's grid

Bookings carry an absolute start time, and the view maps those onto whatever
grid is on screen. That mapping used to **drop** anything it could not place —
so a booking whose time the current rules no longer contain simply vanished from
the device that made it, silently, because a filtered record cannot report
itself missing.

Now such a record keeps its status, is reported as off-grid rather than lost,
and the screen renders it from its own instant. It occupies nothing on a grid it
is not on.

## How two devices find each other

There is no discovery, and no peer list. Everyone tuned to the same Meshtastic
channel and listening on the private application port hears everything — so
"connecting" is not a thing that happens, and neither is a handshake.

What happens instead:

1. On start a device publishes one **digest** — a small fingerprint per day of
   the horizon, **111 bytes for three weeks**, the same size whether the book is
   empty or full and whether two people or two thousand have ever used it.
2. Anyone who hears it compares it with their own, and names **only the days
   that differ**. Those days exchange record keys, then the missing records.
3. If the digests match, **nothing is sent**. Two devices in step exchange one
   frame each and fall silent.

So the answer to *"do they sync every time?"* is no. They compare every time,
which costs one frame, and only talk about what actually differs.

A new booking does not wait for any of that — it goes on the air as it is made.
The digest is the safety net, not the mechanism.

### The greeting repeats, on purpose

A greeting is unacknowledged. If the only one a device ever sent were lost —
the peer's radio busy at that moment, briefly out of range — then neither side
would have any reason to speak again, and both would sit silent with different
books for ever.

So it repeats: roughly **every 45 seconds while nobody has been heard**, and
every **five minutes** once somebody has. Looking for company is worth more
airtime than keeping in step with company you already have, and at one frame
each even the fast cadence is a rounding error against a six-minute hourly
budget.

The horizon is recomputed rather than fixed at load, so a tablet left running
overnight rolls onto the new day instead of quietly disagreeing with everyone
else about which days exist.

## What is bound to what

Worth being precise about, because the answer differs by role.

**Radio nodes are interchangeable.** Nothing in either demo keys on a node's
identity — a node is a radio, and any device may use any node at any time. What
*must* match is the **channel**: reception decodes every channel the node holds
a key for, so a mismatch is silent, with both sides hearing each other's packets
and decrypting none of them. The transmit channel is therefore selectable, and
shown with the first two bytes of its key's SHA-256 so two people can compare
across a room.

**Devices are not interchangeable for the salon.** The salon's identity is a
key in one browser's storage, and only the device holding it can decide.
Opening the shop on a second laptop is refused rather than silently taking over,
because a take-over invalidates every decision the first device ever signed.

**A customer may change device, via the link.** The capability token lives in
the browser that made the booking — but also in the `.ics`, which is what that
link is for.

## Open, and deliberately so

- **Nobody prunes yet.** `log.forgetBefore(day)` exists and is tested, but no
  scheduler calls it. A running app must, or the horizon's tail accumulates —
  the mechanism is there, the policy is not.
- **The digest is a hint, not a proof.** A 32-bit XOR per day plus a count: a
  hash collision *and* an equal count would read as agreement. The odds are
  negligible at these sizes and the failure is silent divergence, so if this
  ever runs somewhere that matters, widen it.
- **A request is not signed, and that is worse than it sounds.** The trade was
  "forging one only creates a booking, which anyone within radio range can
  already do". Measured, it is not one booking: a neighbour with no key, no
  capability and no invitation took **516 of 516 slots** over the default
  three-week horizon, superseding the real customer's confirmed booking, because
  a forged request may claim any timestamp it likes and arbitration correctly
  awards the earliest claim. See
  [#55](https://github.com/NiKrause/funkpost/issues/55). A private channel
  removes the anonymous attacker; it is not authorisation.
- **Every accepted record is written to storage**, so a flood is also a way to
  fill a stranger's disk. Nothing bounds the log.

Solved by the substrate change, and no longer open: unbounded document growth,
and a booking's meaning depending on the horizon it was made in.

---

← [funkpost](../README.md) · [ROADMAP](../ROADMAP.md)
