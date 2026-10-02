<!-- SPDX-License-Identifier: GPL-3.0-only -->

# Notes for agents

What this project has learned the hard way, ordered by how badly it hurts to
rediscover it. **Read §0 and §1 before changing anything that connects a
radio.**

`README.md` says what this is, `ROADMAP.md` where it is going, and `docs/` has
a page per layer. This file is none of those: it is the set of facts that are
expensive to learn twice, and the questions worth asking before writing code.

Every item here was paid for on hardware. Where a number appears, it was
measured; where an issue is cited, that is where the measurement is.

---

## 0. A fix that lives in a page is a fix the next app will not have

The most expensive structural mistake in this repository, and it has happened
to more than one demo.

`serialiseGattOperations()` — the repair for a link that appears to drop and
reconnect forever — was found in [#153](https://github.com/NiKrause/funkpost/issues/153),
built in [#155](https://github.com/NiKrause/funkpost/issues/155) and made the
default in [#160](https://github.com/NiKrause/funkpost/issues/160), *because a
run started without its flag reproduced the storm exactly*. It was called from
one place: mesh-todo's `App.svelte`.

Then [#182](https://github.com/NiKrause/funkpost/pull/182) extracted
`examples/radio/connect.js` so that connecting a radio happened once rather
than once per demo. **Its own docstring names this storm** as one of the
histories it exists to hold in one place. The call stayed behind in the page.

mesh-calendar and mesh-heartbeat therefore shipped without it, and it cost a
field evening: a phone reconnecting continuously, and — the part nobody would
have guessed — beats going out perfectly while almost nothing came back,
because `startNotifications` is one of the operations that loses the race.

**The rule.** A repair about **the radio, the link, or the browser** belongs in
`lib/` or `examples/radio/connect.js`. A page may only decide policy that it
alone knows: what its role is, what it sends, what it draws.

**Before opening a PR**, for anything you fixed in a page:

```bash
grep -rn "theFunctionYouCalled" examples --include=*.svelte --include=*.js
```

If exactly one demo calls it, say in the PR why the other two do not need it.
"Nobody has reported it there" is not an answer — mesh-calendar carried this
defect for weeks with nobody riding a bicycle to find it.

The same sweep, run deliberately, found three more of these. They are listed in
[#191](https://github.com/NiKrause/funkpost/issues/191); it is worth reading
before adding a demo, because whatever is still open there is something the new
one will also be missing.

## 1. One Bluetooth operation at a time

Android Chrome allows exactly one GATT operation, and the Meshtastic connection
sequence reads the node's configuration without awaiting each read. Measured:
**139 overlapping operations** in one short run, and in **every single one** the
blocker was a `readValue`; with the queue off, **121 failures a minute** on one
phone and 45 on the other.

What makes it hard to recognise: **the transport reports a failed operation as
a disconnection.** So the supervisor spends its budget repairing a link that
never broke, every reconnect fix looks like it did nothing, and the error rate
does not move. Everything downstream is a symptom.

`lib/links/gatt-queue.js` is the queue; `examples/radio/connect.js` applies it
on the Bluetooth path, once per page. `?gattq=0` turns it off, `?gatt=1` (in
mesh-todo) reports the overlaps that remain.

**Ask before you build:** does your change add a read or a write to the radio
outside the courier? Then it goes through the queue like everything else — do
not add a path around it.

## 2. Not every "disconnected" is a disconnection

Following from §1, and worth stating separately because it is a *page* decision
and pages keep getting it wrong:

- **`status: "disconnected"`** is a report, not a verdict. The supervisor
  checks `bleDevice.gatt?.connected` and repairs. A page that answers it with
  "node lost — reload to reconnect" sends the operator round a loop the library
  was already getting them out of.
- **`gaveUp`** is the lost link: the supervisor tried, backed off and stopped.
  That is the one worth a banner.
- **An error is transient.** A refused send while the node reports `UNSET` is
  normal and clears itself. A banner that nothing clears outlives its fault —
  we shipped a stale "region is UNSET" under a green "connected · EU_868".
- **`region` is re-reported on every reconfiguration.** Restart on the
  *transition* into usable, not on each report, or you tear down a round that
  was in the air and file the beat it was waiting on as a silence.

All four were bugs in mesh-heartbeat in
[#186](https://github.com/NiKrause/funkpost/pull/186); mesh-todo had already
learned each of them.

## 3. An answer can be slower than the next question

On `LONG_FAST` a round trip of fifteen seconds is ordinary once the ARQ waits
for a routing ACK. So a reply that names request *n* can arrive after request
*n+1* has gone out.

`track.answered()` matched only the newest open beat and discarded the rest as
duplicates. The wire was right; the record was wrong, and a ride that was being
answered was written down as silence.

**Ask before you build:** if you are correlating a reply with a request, what
happens when it arrives one request late? Match on what the message *names*,
scoped to the exchange it belongs to — never on "the most recent thing I sent".

## 4. A screen has to be able to say what the device did

A device whose only job is to answer read *"nothing sent yet"* all day, because
the lamp tracked beats and an answer is not a beat. From the other end of a
radio link that is indistinguishable from a device that is not answering — and
it is the one thing the other end needs to know.

The same evening: the stationary device had **no record at all**, and under the
lamp a summary of a ride it was not on.

**Two devices, two records, and neither is derivable from the other.** A
silence at one end is two different failures — the message never arrived, or
the answer never made it home. Only both screens together tell them apart.

**Ask before you build:** for each device in the experiment, can its screen
alone answer "what did I send, what arrived, and what did I do about it?"

## 5. Airtime is the budget

Measured, not assumed: **about 500 bytes a minute** of goodput
([field notes](docs/field-notes.md)), and the legal ceiling in EU 868 is **10 %
duty cycle — six minutes an hour**. Those are two different ceilings and the
node keeps its own count of the second one.

Consequences already designed around this: a position sent once rather than on
every message; a round that ends at the first answer; a greeting that does not
grow with the number of writers
([#45](https://github.com/NiKrause/funkpost/issues/45)); an operation plane of
86 bytes where a signed entry is 1774
([data plane](docs/data-plane-orbitdb.md)).

**Ask before you build:** how many bytes, how often, and what does that come to
in an hour? Put the answer in the PR. If a page offers the choice, it should
show the cost — mesh-heartbeat's interval selector does.

**And measure it rather than estimating it.** `test/heartbeat.test.js` pins 34
bytes for a beat and 15 for a position, because three documents and a screen
quote them.

## 6. The phone is the unreliable half

- **Web Bluetooth pauses when the screen locks.** The node stays connected and
  the page cannot talk to it. Every demo has a *keep the screen awake* toggle;
  a new one needs it too, and on a bicycle nobody is there to notice.
- **A reload drops the Bluetooth link** and needs a press to come back.
- **The console is invisible on a phone.** mesh-todo installs `error` and
  `unhandledrejection` handlers that write into its on-screen log; the other
  demos do not, and an exception in a handler tears a connection down silently.
- **A field log nobody was subscribed to is gone.** mesh-todo keeps unheard
  lines in a ring and replays them when a watcher appears
  (`examples/mesh-todo/src/field-log-buffer.js`) — which is exactly the run
  worth watching, the one with no internet.

**Ask before you build:** will this be used out of coverage, on a phone, by
somebody who cannot look at the screen? Then the record has to survive the
device.

## 7. A channel mismatch is silent

Two nodes on different channels behave exactly like two nodes out of range. The
index is per device, so the only thing two operators can agree on is a **name**
— `lib/links/channel-preference.js` moves a page onto it, and every demo shows
`⌗fingerprint` with the channel selector so it can be compared across devices.

Importing a channel also **reboots the node and often resets the region to
`UNSET`**, after which it refuses to transmit.

## 8. Tests: what is cheap, what is a trap

- **`?mesh=bc`** replaces the radio with a `BroadcastChannel`, so two tabs play
  two devices with no hardware. Everything except the radio can be tested this
  way, and is.
- **Break your check before you trust it.** A test that passes is not evidence
  until it has failed for the right reason. Doing this has caught: an assertion
  placed before the code it claimed to test, a `sed` that matched nothing and
  "passed", and a spec whose guard could be deleted with the suite still green.
- **Playwright's `context.setGeolocation` moves every page in the context**, and
  two devices must share a context because a `BroadcastChannel` does not cross
  one. The position is stubbed per page in `e2e/devices.js` for that reason.
- **A test that has to act *between* two events needs a wide gap, not a fast
  one.** `open()` lets a query's own `gap=` win; the suite's default seventh of
  a second failed about one run in three and passed alone every time, which is
  the shape that gets called flaky and retried instead of read.
- **Distances do not pin a scale factor.** Both ends scale with the same
  constant, so an error cancels itself over the wire. The scale rests on
  raw-integer cases in `test/position.test.js`.
- **Never hand a whole document to `assert.match`.** Node 22's test runner
  stalls while it formats the failure — a 3.6 KB page is enough — so the
  regression reports itself as a hung CI job instead of a red test. Read the
  needle out and compare *that*, which is also the only way the message says
  anything. Reproduced: a short-string failure right before it reports fine.
- **Two demos must not preview-serve on the same port.** `reuseExistingServer`
  is on locally, so a leftover server from one suite silently has the next one
  testing the wrong app. One port each: 4173, 4174, 4175, 4176.
- **The lockfile must be generated with the npm that CI runs** — Node 22's npm
  10. An npm 11 lockfile fails `npm ci`: `npx npm@10 install`.

## 9. A shared link cannot be told a language

A social card is read by a **scraper**, not a browser. It never runs the page,
so the language somebody switched on is invisible to it; it has no
`localStorage`, sends no useful `Accept-Language`, and caches what it finds
**per URL**. One address therefore has exactly one preview, in one language,
for everybody who pastes it anywhere.

The only fix is a second address. Every page here exists twice —
`/mesh-trail/` and `/mesh-trail/de/` — and the German one is *generated* from
the English one at build time by `scripts/make-german-pages.mjs`, so a
correction to one head cannot silently leave the other behind. It is
git-ignored and listed as a second Vite input.

Three traps, each of which looks like something else when it bites:

- **A reference written for the page one level up 404s one level down.** Vite
  copies `public/` verbatim and rewrites nothing. The generator turns `./x`
  into `../x` — and then *asserts* that nothing relative survived, because the
  landing page reaches `brand.js` from an import map and a module script,
  neither of which has an `href`, and a missing pill looks like a plain page
  rather than an error.
- **The manifest is the exception**, and must stay `./manifest.webmanifest`.
  `start_url: "./"` has to mean *this* page, or installing from German installs
  the English app.
- **`new Request("./")` in a service worker resolves against `sw.js`**, not
  against the page. Every navigation under `/de/` was keyed to the English
  shell, so offline a German link served an English page and nothing said why.
  The key is `new URL("./", request.url)`. The install step takes **both**
  shells and the page caches the address it was opened at, because the
  navigation that registers a worker is over before the worker can see it.

**Ask before you build:** will the page you are adding exist in both languages?
If it carries an `og:image`, it needs a German card and an entry in `GERMAN`;
if it is copied rather than bundled, like the landing page, the deploy has to
generate its twin.

---

## Before you ask for a review, check

1. If you fixed something about the radio, the link or the browser — is it in
   `lib/` or the shared connector, and does `grep` show all four demos getting
   it? (§0)
2. Does the page treat a reported disconnection as a report rather than a
   verdict? (§2)
3. Can each device's screen say what it sent, what arrived, and what it did
   about it? (§4)
4. How many bytes, how often, and what is that an hour? (§5)
5. Did you break every new assertion to see it fail? (§8)
6. If you added a page, or changed what one says about itself — does it exist
   in both languages, with a card of its own? (§9)
7. Conversation in German if that is how it started; **issues, PRs, commits,
   code and docs in English.**
