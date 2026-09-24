<!-- SPDX-License-Identifier: GPL-3.0-only -->

# Run sheet: what the next bench has to show

Status: **three runs open.** All pass in the browser over a fake mesh; what is
left needs two Meshtastic nodes on a bench, not another commit.

| run | the question | gate |
|---|---|---|
| [**A** · internet first, the mesh when it goes](#run-a-internet-first-the-mesh-when-it-goes) | does the fallback hold on real radios? | [ROADMAP](../ROADMAP.md) P10 · [#82](https://github.com/NiKrause/funkpost/issues/82) |
| [**B** · a decision crosses the mesh](#run-b-a-decision-crosses-the-mesh) | does a salon's yes reach the customer? | [ROADMAP](../ROADMAP.md) P7 · [#38](https://github.com/NiKrause/funkpost/issues/38) A7 |
| [**C** · a whole list over LoRa, cold](#run-c-a-whole-list-over-lora-cold) | can a list be joined with no internet at all? | [#153](https://github.com/NiKrause/funkpost/issues/153) · [#158](https://github.com/NiKrause/funkpost/pull/158) |

Each run says what to press, what to write down, and **when it counts**. The
pass line is the ROADMAP's gate, not a new one. Results go into the
[field notes](field-notes.md) as a dated entry.

Not on this sheet: **P11**, a lost phone and the same passkey. It needs no
radio — two phones, one security key and the
[recovery page](https://nikrause.github.io/funkpost/recovery/).

## Before either run

Once per bench, and again after anything that reboots a node.

- [ ] **Two nodes on `EU_868`.** Write down each model and firmware version.
- [ ] **One channel on both, selected for sending on both.** The page shows
      `»name« ⌗fingerprint` beside the selector; compare it across the two
      devices, because a mismatch is silent. The
      [le-space.de test channel](../README.md#the-test-channel) works, or make
      your own with `npm run channel` ([channels](channels.md)).
- [ ] **The region, after every import.** Importing a channel reboots the node
      and often resets the region to `UNSET`. The page then refuses to
      transmit, and says so.
- [ ] **Role `CLIENT_MUTE`, transmit power down** —
      [bench etiquette](bench-etiquette.md) §3 and §5.
- [ ] **Preset `LONG_FAST` for the run you record.** It is what a village mesh
      runs, so its numbers are the ones worth having. `SHORT_FAST` is fine for
      a rehearsal, if both nodes change together. **Not `SHORT_TURBO`**: it
      needs 500 kHz, and EU 868 is 250 kHz wide
      ([bench etiquette §4](bench-etiquette.md#4-use-a-fast-modem-preset)).
- [ ] **The official Meshtastic app closed** on both phones. A node takes one
      Bluetooth client, and the app takes the slot back.
- [ ] **A Chromium browser** — Chrome on Android; Chrome, Edge or Opera on a
      desktop. Firefox and Safari have no Web Bluetooth, and neither does any
      browser on iOS. On a phone, tick *keep the screen awake*: Web Bluetooth
      pauses when the screen sleeps. A Samsung that never lists the node:
      developer options → *Show unsupported Bluetooth LE devices*.
- [ ] **A fallback you name.** If a phone will not hold its link, run that end
      in desktop Chrome and write down which end was which. The gate is met
      either way; only the phone question (#1) stays open.
- [ ] **No reloads mid-run.** A reload drops the Bluetooth link, which needs a
      press to come back, and loses the page's place in the script.

A third node in the official app, on the same channel and sending nothing, is
worth having: it answers *is anything reaching the air at all* without adding
traffic ([a three-device bench](bench-etiquette.md#a-three-device-bench)).

Airtime is measured by the node as **a percentage of the last hour — 1 % is
36 s of transmitting.** The legal ceiling in EU 868 is 10 %, six minutes an
hour.

## Run A: internet first, the mesh when it goes

Two phones keep one list over the internet. The internet goes; the page
notices, says so, asks before touching the radio, finds out whether the other
*app* is listening, and sends what changed over LoRa.

**Page:** <https://nikrause.github.io/funkpost/mesh-todo/>, without
parameters. The internet path is on by default.

**Cutting the internet:** Wi-Fi *and* mobile data off. **Not flight mode** —
on most phones it switches Bluetooth off too, and the link to the node is the
one thing that has to survive. On a laptop, Wi-Fi off.

| # | where | do | expect |
|---|---|---|---|
| 1 | both | open the page | the sync pane: `internet path up — relays from Aleph (orbitdb-relay)` |
| 2 | both | *Connect node*, pick the TX channel; note `node airtime` | `region EU_868`, the same `»name« ⌗fingerprint` on both |
| 3 | A | *Create a list* | an address; `invite sent over the mesh` |
| 4 | B | *Join this list* when the invitation arrives | `joined over the internet`, then `0 entries`. Nothing after a minute: *Invite again* on A |
| 5 | both | — | `carried by the internet · … peers over IP` — at least one (a relay), more once the phones have found each other |
| 6 | A | add an entry | it appears on B **with nothing pressed** — the internet carried it. On the mesh path the same entry would wait for the send button |
| 7 | both | cut the internet; note the time | `internet gone` under the list, then *Continue over the LoRa mesh?* Note how long it took — the browser test allows 90 s |
| 8 | both | *Continue over the mesh* | `carried by the mesh`, and the page asks the air on its own |
| 9 | whichever accepted first | *Is anyone out there?* | `1 app out there keeping this list`. The automatic ask went out while the other side was still on the internet, where it cannot answer |
| 10 | A | add an entry, *Send 1 change*; note the time | it appears on B — note when |
| 11 | B | the same, the other way | it appears on A |

**It counts** when steps 7 to 10 happen on the two nodes as written: the loss
is noticed through a failed dial and said, the page asks before the log moves,
the answer counts the other app, and the change crosses LoRa. That is the open
half of P10's gate.

**Then, not part of the gate:** internet back on, *Carry it over the internet
instead* on both. Expect `internet back`, `carried by the internet`, one more
entry crossing with nothing pressed, and two identical lists. The way back has
only been tested in Node
([`fallback-one-log.test.js`](../test/fallback-one-log.test.js)), never in a
browser, so whatever happens here is news — write it down either way.

**Write down:**

- the times of steps 7 to 11, on both devices;
- what step 9 answered, word for word;
- from the sync pane after step 11: `frames → · ←`, `retransmit rounds`,
  `est. airtime`, and `radio gave up on …` if it appears;
- `node airtime` on both, right after step 2 and again after step 11;
- a screenshot of both lists at the end, and of both sync panes.

## Run B: a decision crosses the mesh

`mesh-calendar` in *Rückfrage* mode: the customer asks, the salon decides, and
the decision — a record the salon signs — travels back. The run of 6 September
was in auto mode, which never sends a decision, so this half has not crossed a
real mesh yet.

**Page:** <https://nikrause.github.io/funkpost/mesh-calendar/> on both devices.
The page is in German, so the labels below are too.

| # | where | do | expect |
|---|---|---|---|
| 1 | salon | *Ich bin der Salon*, *Knoten verbinden*, pick the *Sendekanal* | `Funk offen, noch niemand gehört` |
| 2 | customer | *Ich möchte einen Termin*, *Knoten verbinden*, the same *Sendekanal* | the same `»name« ⌗fingerprint` as the salon; both status lines turn to `1 Gerät in Reichweite` |
| 3 | salon | *Tagesplan* → *Rückfrage* | — |
| 4 | customer | wait | *Der Salon bestätigt jede Anfrage einzeln.*, and the button reads *Termin anfragen*. **This is the evidence that the rule crossed**: the page starts from *Autobestätigung* out of its own source, which is why a rendered calendar proves nothing ([field notes](field-notes.md#the-first-booking-and-the-two-hours-before-it)) |
| 5 | customer | a service, a name, a day, a time → *Termin anfragen*; note the time | under *Deine Termine*: `wartet auf den Salon` |
| 6 | salon | note when *Neue Anfrage über Funk* appears → *Bestätigen*; note the time | on that day, the day plan shows the customer's name and `bestätigt` |
| 7 | customer | note when the booking turns `bestätigt` → *Termin.ics*, open the file | the phone's calendar offers to add it — note which app, and whether it did |

**It counts** when the salon's *Bestätigen* reaches the customer over the mesh
(step 7), after step 4 has shown that the rule crossed. The `.ics` on both
phones is the other half of the gate, and it cannot be met yet:

- **The salon has no `.ics` button.** The domain can already write the
  salon's version — `icsFor(id, { role: "salon" })` puts the customer's name
  in the note — but nothing in the salon view calls it. Until something does,
  note the gap; do not work around it.
- **No airtime on screen.** Unlike `mesh-todo`, this page shows neither the
  node's airtime nor its own estimate. Read each node's *AirUtilTX* in the
  official app before step 1 — then close the app completely — and again after
  closing the tab. Note that the number came from the app: the 6 September
  figure never said where its number came from.

The customer's file also answers part of P4's manual check: which calendar
apps accept it. One phone's calendar is one data point; the full check names
Apple Calendar, Google Calendar and Thunderbird
([mesh-calendar](mesh-calendar.md#what-ci-cannot-prove)).

**Write down:**

- the times of steps 5 to 7: request → the salon sees it; *Bestätigen* → the
  customer sees it;
- the radio strip on both: `Frames`, `Runden`, `Aufgegeben` if it appears,
  `Sendungen` — and open it for a screenshot of its log;
- *AirUtilTX* on both nodes, before and after;
- the calendar app, and whether the import worked.

## Run C: a whole list over LoRa, cold

Runs A and B both start online: by the time the radio matters, each phone
already holds the list, and only changes have to cross. This one asks the
harder question — **can a device get a list it has never seen, with no
internet at any point?** That is the whole bootstrap over LoRa, not a delta.

It was attempted on 2026-09-24 and could not be finished: the joining phone
kept trying over the internet it did not have, and never transmitted (see the
[field notes](field-notes.md)). [#158](https://github.com/NiKrause/funkpost/pull/158)
is the fix; this run is how we find out whether that was the only obstacle.

**Page:** <https://nikrause.github.io/funkpost/mesh-todo/?log=1>, so the run
can be read afterwards — the log is kept while offline and sent when the
network returns.

**Do not reload after step 4.** The stores are in memory on purpose (*"Reset
is a reload"*), so reloading destroys the list the run is about. Cutting the
internet is safe; reloading is not.

| # | where | do | expect |
|---|---|---|---|
| 1 | both | open the page (internet still on — the app has to load once) | `internet path up` |
| 2 | both | *Connect node*, pick the TX channel | `region EU_868`, the same `»name« ⌗fingerprint` on both |
| 3 | both | switch on *carry the list over the radio* | `list sync on — the radio carries changes again` |
| 4 | both | cut Wi-Fi **and** mobile data. Not flight mode, and **no reload** | `internet gone` |
| 5 | A | *Create a list* | an address, and `invite sent over the mesh` |
| 6 | B | *Join this list* | the LED turns cyan, and the join goes **on the air** — B must transmit. A join that fails with `Failed to load block` means it still took the internet path |
| 7 | B | — | `0 entries`, and the list address matches A's |
| 8 | A | add an entry, *Send 1 change* | it appears on B; note how long the whole list took to cross |
| 9 | B | tick it off, *Send 1 change* | A shows it ticked |

**It counts** when step 6 completes with no internet on either device — a list
that has never existed on B arrives over the radio alone. Steps 8 and 9 then
show it is a real list and not a snapshot.

**Write down:** the time from step 6 to step 7 (the bootstrap), the size of
the list, and every line starting with `!`. With `?log=1` on both phones, a
watcher picks all of it up afterwards:

```bash
RELAY_ADDRS=/dns4/…/p2p/12D3… node scripts/watch-field-log.mjs --out run-c.ndjson
```

## Watch during every run

- **Bluetooth drops** (#1). `mesh-todo` says `link dropped — reconnecting
  automatically…`; `mesh-calendar` logs `Verbindung weg — Versuch …` in its
  radio strip. Count them, and note whether each came back without a reload.
  The reconnect supervisor moved into the library (#37) and has not run on
  hardware since — these runs are its re-run.
- **Airtime against the estimate** (#73), in runs A and C — the booking page shows
  no estimate. Compare the rise in `node airtime` (1 % = 36 s) with
  `est. airtime` in the sync pane. If the node spent about three times what
  the page estimates, that is #73's suspicion that `want_ack` on broadcasts
  triples the cost. Beacons and telemetry count in the node's number too, so
  write both down either way.
- **Lines that start with `!`** are errors the page caught. A screenshot is
  worth more than a description.

## Afterwards

Photos of both screens and the notes below are enough to write a run up from.
It lands in the [field notes](field-notes.md) as a dated entry, in the gate
line of the [ROADMAP](../ROADMAP.md), in the [README](../README.md#status)'s
status, and on [lora.le-space.de](https://lora.le-space.de/).

```text
Run A / B / C — date, time, place
Devices    A: model · Android · Chrome        B: model · Android · Chrome
Nodes      A: model · firmware                B: model · firmware
Air        region · preset · »channel« ⌗fingerprint · role · TX power · distance
Build      from the page footer: funkpost … · commit · built
Airtime    before  A: … %   B: … %            after  A: … %   B: … %   (source: page / app)
Times      the steps the run asks for
Counters   the sync pane or radio strip, after the run
Drops      how many, and whether each came back on its own
Errors     every line starting with !
Counts?    yes / no — and why
```

---

← [funkpost](../README.md) · [ROADMAP](../ROADMAP.md) · [bench etiquette](bench-etiquette.md) · [field notes](field-notes.md)
