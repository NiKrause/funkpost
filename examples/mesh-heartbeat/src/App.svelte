<!-- SPDX-License-Identifier: GPL-3.0-only -->
<!--
  How far does the mesh reach? (#180)

  Two nodes, no database. One device stays where it is and answers; the other
  rides away and asks. What comes back is a list of places with an answer or a
  silence against each — and, where there was an answer, which beat of the
  round carried it. A round's beats are fifteen seconds apart, so "answered at
  once" and "answered on the third" are half a minute and, on a bicycle, a
  couple of hundred metres.

  This is a separate page rather than a mode of mesh-todo for one reason worth
  stating: it has no database at all. No Helia, no OrbitDB, no libp2p — the
  whole import list is a radio and a heartbeat. A range test that dragged a
  replication stack behind it would be measuring the stack.

  MORE THAN TWO DEVICES on one channel, measured over a simulated hour with
  beats 15 s apart (the numbers are per hour of air, against the ~500 B a
  minute this carrier was measured to move):

    1 rider, nobody answering      37 beats,   0 echoes   1258 B    4.2%
    1 rider + 1 office             14 beats,  13 echoes    918 B    3.1%
    1 rider + 2 offices            14 beats,  26 echoes   1360 B    4.5%
    2 riders + 1 office            26 beats,  49 echoes   2550 B    8.5%
    3 riders, no office            39 beats,  75 echoes   3876 B   12.9%

  Three things follow. **An answered device is cheaper than a lonely one** —
  the round ends at the first answer, so a good spot costs one beat rather than
  three, and the echo more than pays for itself. **Each extra listener adds one
  echo per beat**, linearly: the library answers any one sender at most once
  every half-minute-equivalent, so there is no storm. **The askers are the
  expensive ones** — three riders at the one-minute interval take about
  two-thirds of the carrier, which is why a range test wants one device on
  "travels and asks" and every other device on "stays here and answers".

  Two limits of this page with a crowd, stated rather than discovered:

  - With two *riders*, one rider's beat closes the other's round — the library
    treats "somebody is out there" as an answer, even though nothing answered
    that device's own beat. The track still records it as a silence, because
    only an echo closes a point here; but the round gets fewer tries than it
    looks like it did.
  - `officeAt` is a single slot. With two stationary devices the second echo
    overwrites the first one's position and the distance column jumps between
    them.
-->
<script>
  import { onMount } from "svelte";
  import { creditHTML, lang } from "@le-space/funkpost-brand";
  import { connectCourier, watchWindowErrors } from "@le-space/funkpost-radio";
  import { createChannelBook } from "@le-space/funkpost-radio/channels.js";
  import { createWakeLock } from "@le-space/funkpost-radio/wake-lock.js";
  import { kept, keep, chosen } from "@le-space/funkpost-radio/kept.js";
  import JumpBar from "@le-space/funkpost-radio/JumpBar.svelte";
  import {
    describeMeshtasticError,
    DEFAULT_PREFERRED_CHANNEL,
  } from "@le-space/funkpost";
  import { createHeartbeat } from "@le-space/funkpost/heartbeat";
  import { databaseTag } from "@le-space/orbitdb-storage-bridge/courier-sync";
  import { createCoverageTrack } from "./track.js";
  import { createHeardLog } from "./heard.js";
  import { rideToCsv, heardToCsv, rideFilename, downloadText } from "./ride-file.js";
  import RideMap from "./Map.svelte";
  import {
    decodeNodePosition,
    preferFix,
    fixAgeMs,
    encodeNodePosition,
    watchBrowserPosition,
    askForPosition,
    formatPosition,
    distanceMetres,
    formatDistance,
  } from "@le-space/funkpost-radio/position.js";
  import { WORDS } from "./words.js";

  const t = $derived(WORDS[$lang]);
  const w = () => WORDS[lang.get()];
  $effect(() => {
    document.title = t.title;
  });

  const build = __BUILD_INFO__;
  const params = new URLSearchParams(location.search);

  /**
   * The question both devices have to be asking.
   *
   * The heartbeat is keyed by a tag, and a tag is a hash of an address. There
   * is no list here, so the address is a well-known name — the same one
   * mesh-todo uses when it has no list either, which is deliberate: a
   * mesh-todo phone left on the windowsill is a perfectly good stationary
   * half of this experiment, and it would not be if the two pages hashed
   * different names.
   */
  const ANYBODY = "funkpost/anybody-there/1";

  const mode =
    params.get("mesh") === "bc"
      ? {
          kind: "bc",
          room: params.get("room") ?? "mesh-heartbeat",
          loss: Number(params.get("loss") ?? 0),
          preset: params.get("preset") ?? undefined,
        }
      : { kind: "ble" };

  /**
   * How long fifteen seconds is.
   *
   * The round is three beats fifteen seconds apart with a seven-and-a-half
   * second window after the last — 52.5 s, which fits inside the shortest
   * interval on offer. It very nearly did not: the first choice was twenty
   * seconds apart, which with the same window is seventy, and
   * `createHeartbeat` refuses a round that cannot end before the next one
   * starts. The e2e suite shortens this
   * rather than waiting out a real one.
   */
  const beatGapMs = Math.max(50, Number(params.get("gap")) || 15_000);
  const BEATS_PER_ROUND = 3;
  const answerWindowMs = Math.max(25, Math.round(beatGapMs / 2));
  const showLog = params.get("log") === "1";

  /** A beat on the wire, measured rather than guessed — see test/heartbeat.test.js. */
  const BEAT_BYTES = 34;
  /** What saying where costs, on the first beat of each round. Measured there too. */
  const POSITION_BYTES = 15;

  let phase = $state("idle"); // idle → connecting → ready | lost
  let linkKind = $state("");
  let region = $state("");
  /**
   * A reason the page is stuck, and only that.
   *
   * NOT every error the courier reports. A refused send is normal and
   * transient — the commonest is the node reporting its region a second after
   * the link comes up, so the first beat goes out before the courier knows the
   * local airtime law and is rightly refused. Putting that in a banner leaves
   * "region is UNSET — refusing to transmit" sitting under a green "connected ·
   * EU_868" for the rest of the session, which is what a field photograph
   * showed. Those go to the log; this is for a connect that failed and for a
   * link the supervisor has given up on.
   */
  let error = $state("");
  let reconnecting = $state(false);
  let myNodeNum = $state(null);
  /** Which node this is: its four display characters and its !id. */
  let myNode = $state(null);
  let airUtil = $state(null);
  /** The heartbeat's own view of itself, including an error it clears again. */
  let beatState = $state(null);

  /** What this device does: answer and stay, or ask and travel. */
  // Nothing was kept here at all before: role, interval, partner and the
  // screen lock were re-chosen on every launch, which on a bench is four
  // decisions before the first beat.
  const ROLE_KEY = "mesh-heartbeat:role:v1";
  const EVERY_KEY = "mesh-heartbeat:every:v1";
  const PARTNER_KEY = "mesh-heartbeat:partner:v1";
  const AWAKE_KEY = "mesh-heartbeat:awake:v1";
  const HOLD_STALE_KEY = "mesh-heartbeat:hold-stale:v1";

  let role = $state(
    chosen(
      params.get("role"),
      (asked) => (asked === "office" || asked === "rider" ? asked : undefined),
      ROLE_KEY,
      "rider",
    ),
  );
  /** Minutes between rounds; 0 is the button and nothing else. */
  let everyMin = $state(chosen(params.get("every"), Number, EVERY_KEY, 2));

  let here = $state(null); // { lat, lon, at, source }
  let officeAt = $state(null); // where the other device said it is
  /**
   * Which device this one is measuring against; "" means whoever answers.
   *
   * A channel is shared. Every device running this app with the same question
   * hears every other, so two people testing their own pairs on the public
   * channel answer each other's beats — and a track that took any answer would
   * report a stranger's coverage as this device's. Empty is right when nobody
   * else is out there, which is the common case and so the default; naming the
   * partner is what makes the measurement hold when somebody is.
   */
  let partner = $state(chosen(params.get("partner"), String, PARTNER_KEY, ""));
  /** Every device heard so far, so the partner can be picked rather than typed. */
  let heardIds = $state([]);

  let pingOut = $state(null); // a beat { at, n, of } or an echo { at, echo, to, n }
  let pingIn = $state(null); // { at, type, from, n, bytes }

  let rows = $state([]); // the track, newest first for the screen
  let heardRows = $state([]); // what reached this device, newest first
  let heardSummary = $state({ heard: 0, answered: 0, askers: 0, echoes: 0, located: 0 });
  /**
   * What is left of this hour, which is law rather than preference.
   *
   * This page schedules itself and runs for an hour in somebody's pocket — it
   * is the demo with the strongest claim on this number and was the one
   * without it. mesh-todo only transmits when a person presses something, and
   * it is the one that had the bar.
   */
  let budget = $state(null);
  let blockedForMs = $state(0);
  let budgetTimer = null;
  /**
   * Set when a send failed inside the round that is running.
   *
   * A silence is evidence only if the beat actually went out. A round that
   * could not transmit — an exhausted hour, a node that refused — says nothing
   * about the place it was sent from, so it is abandoned rather than written
   * down as a red mark somebody might ride back to and puzzle over.
   */
  let roundFailed = false;
  let summary = $state({ sent: 0, reached: 0, firstBeat: 0, located: 0 });
  let log = $state([]);

  // Which channel the radio transmits on. The index is per device — the same
  // channel can be 1 here and 3 there — so the preference is by name, and the
  // page moves itself onto it once the node has reported it.
  const preferredChannel = params.has("channel")
    ? params.get("channel")
    : DEFAULT_PREFERRED_CHANNEL;
  let channels = $state([]);
  let txChannel = $state(0);
  let primaryChannel = $state(null);
  let setTxChannelFn = () => {};

  /**
   * Keeping the screen awake — the bench's quiet killer, and worse here.
   *
   * Phones auto-lock, and Web Bluetooth pauses with the screen: the node stays
   * connected, the page stops being able to talk to it, and the ride records
   * an hour of silence that was never about the radio. On a bicycle nobody is
   * looking at the screen to keep it alive, so this is the one demo where the
   * checkbox is close to mandatory.
   *
   * The detection deliberately does not trust `userAgentData.mobile` alone: an
   * unfolded Samsung Fold and Android tablets report `false` while still being
   * battery devices that sleep the screen.
   */
  const isMobileDevice =
    navigator.userAgentData?.mobile === true ||
    /Android|iPhone|iPad|iPod|Mobi/i.test(navigator.userAgent);
  const wakeLockSupported = "wakeLock" in navigator;
  let keepAwake = $state(false);
  /**
   * Whether an old fix is held back rather than sent. Off by default.
   *
   * A fix from a device that has not *moved* is still where that device is,
   * and this one stays put on purpose. Silence would make the office vanish
   * from the rider's map with nothing to say why.
   */
  let holdStale = $state(kept(HOLD_STALE_KEY, false));

  let courier = null;
  let radio = null;
  // $state, because the Ask-now button reads it: a plain variable would leave
  // the button disabled after the heartbeat had started.
  let heartbeat = $state(null);
  /** A round is in the air, so there is nothing for the button to ask. */
  let roundRunning = $state(false);
  let stopWatchingBrowser = null;
  /**
   * What the browser last said when it had no position to give.
   *
   * Reported from the field: the map came up, nothing ever moved, and the page
   * had nothing to say about it — through a tethered hotspot and through no
   * internet at all. The receiver's silence was indistinguishable from the
   * page never having asked.
   */
  let fixTrouble = $state(null);
  /** Ticks so the age of the last fix is a number that visibly moves. */
  let nowTick = $state(Date.now());
  let tickTimer = null;
  let stopWindowErrors = null;
  const track = createCoverageTrack();
  // The stationary half's own record. It is not the ride: it is what reached
  // this device and what it sent back, which is the other half of every
  // silence on the phone.
  const heardLog = createHeardLog();

  /**
   * One device id for the life of the page, not one per heartbeat.
   *
   * The id is how the other side counts peers. Restarting the heartbeat — and
   * every change of role or interval does — with a fresh one would make one
   * bicycle look like a fleet.
   */
  const deviceId = globalThis.crypto.getRandomValues(new Uint8Array(4));

  const pushLog = (line) => {
    log = [...log.slice(-199), { at: Date.now(), line }];
  };
  const clockText = (at) =>
    at == null ? "" : new Date(at).toLocaleTimeString(undefined, { hour12: false });

  const refreshTrack = () => {
    rows = track.points().reverse();
    summary = track.summary();
  };

  const refreshBudget = () => {
    if (!courier) return;
    budget = courier.budget?.() ?? null;
    // Asking costs nothing and does not spend the budget — that is what
    // `timeUntilAffordable` is for. Priced for a beat that carries a place,
    // because that is the biggest thing this page sends.
    blockedForMs = courier.timeUntilAffordable?.(BEAT_BYTES + POSITION_BYTES) ?? 0;
  };

  const refreshHeard = () => {
    heardRows = heardLog.rows();
    heardSummary = heardLog.summary();
  };

  // ---------------------------------------------------------------- the radio

  async function connect() {
    if (phase === "connecting" || phase === "ready") return;
    phase = "connecting";
    error = "";
    // Forget the last one. Reconnecting to the same node fills this in again
    // within a second; connecting to a *different* one would otherwise show
    // the old four characters until its name arrived, which is the one moment
    // this line exists to get right.
    myNode = null;
    try {
      radio = await connectCourier({
        mode,
        onTelemetry: (value) => (airUtil = value),
        // Logged, never a verdict. The transport reports a failed GATT write
        // as a disconnection and Android Chrome produces those readily — the
        // supervisor knows it, checks whether the link is actually alive, and
        // repairs it. A page that answers every "disconnected" with "node
        // lost — reload to reconnect" sends the operator round a loop the
        // library was already getting them out of.
        onStatus: (name) => pushLog(w().log.nodeStatus(name)),
        // mesh-todo's GATT queue, now applied by the shared connector rather
        // than by whichever page remembered to ask for it.
        onGattQueue: () => pushLog(w().log.gattQueueOn),
        onRegion: (name) => {
          // Only when it *becomes* usable. The node re-reports its region on
          // every reconfiguration, and restarting on each one tears down a
          // round that was in the air — which, before this guard, also filed
          // the beat it was waiting on as a silence.
          const wasUnusable = region === "" || region === "UNSET";
          region = name;
          pushLog(w().log.region(name));
          if (wasUnusable && name && name !== "UNSET") restartHeartbeat();
        },
        onChannel: handleChannel,
        onMyNodeInfo: (info) => (myNodeNum = info?.myNodeNum ?? info?.num ?? null),
        // "Connected" is not an answer in a room with two radios in it.
        onIdentity: (who) => (myNode = who),
        onNodeInfo: (node) => {
          // The node database includes this node. Its own entry is the fix we
          // want; every other entry is somebody else's position and would
          // plot this ride wherever they happen to be.
          if (myNodeNum == null || node?.num !== myNodeNum) return;
          const fix = decodeNodePosition(node.position);
          if (fix) setHere(fix);
        },
        onReconnecting: (n) => {
          reconnecting = true;
          pushLog(w().log.linkDropped(n));
        },
        onReconnected: () => {
          reconnecting = false;
          phase = "ready";
          pushLog(w().log.reconnected);
        },
        // *This* is a lost link: the supervisor tried, backed off and stopped.
        // Everything before it was a repair in progress.
        onGaveUp: () => {
          reconnecting = false;
          phase = "lost";
          error = w().errors.gaveUp;
          pushLog(w().log.gaveUp);
        },
        onError: (message) => pushLog(w().log.error(message)),
        onGattProbe: (line) => pushLog(line),
      });
      courier = radio.courier;
      linkKind = radio.kind;
      region = radio.region;
      setTxChannelFn = radio.setTxChannel ?? (() => {});
      // Deliberate test seam, as in mesh-todo: the fake mesh reports no
      // channels, and channel selection is a path that fails *silently* when
      // it is wrong — so it is worth exercising rather than reasoning about.
      window.__nodeChannel = handleChannel;
      // Act on whatever the node reported while the connection was still
      // coming up, now that the switch does something.
      // Act on whatever the node reported while the connection was still
      // coming up. Re-noting a channel the book already has is how it retries
      // the preference, now that the switch does something.
      for (const ch of channelBook.channels()) {
        channelBook.note({ index: ch.index, role: ch.role, settings: { name: ch.name } });
      }
      phase = "ready";
      refreshBudget();
      // The bucket refills continuously, so the only way a screen can say
      // "another twelve minutes" and still be right a minute later is to ask
      // again. Five seconds is far below the resolution anyone reads it at.
      budgetTimer = setInterval(refreshBudget, 5_000);
      startHeartbeat();
    } catch (e) {
      phase = "idle";
      error = describeMeshtasticError(e) ?? e?.message ?? String(e);
      pushLog(w().log.error(error));
    }
  }

  /** One channel as the node reports it. Named, so a test can hand one over. */
  /** Named, so a test can hand one over. The book does the rest. */
  const handleChannel = (channel) => channelBook.note(channel);

  /**
   * The table, the fingerprints and the by-name preference live in the shared
   * radio package — the same code four pages carried, and the one path that
   * fails *silently* when it is wrong.
   */
  const channelBook = createChannelBook({
    preferred: preferredChannel,
    setTxChannel: (index) => setTxChannelFn(index),
    onEvent: (event) => {
      channels = channelBook.channels();
      txChannel = channelBook.tx();
      primaryChannel = channelBook.primary();
      if (event.kind === "channel") {
        const c = event.channel;
        pushLog(w().log.nodeChannel(c.index, c.name, c.fingerprint));
      }
      if (event.kind === "preferred") {
        pushLog(w().log.autoChannel(event.index, event.channel?.name, event.channel?.fingerprint));
      }
      if (event.kind === "changed") changeChannel();
    },
  });

  /** A channel change invalidates everything heard so far. */
  function changeChannel() {
    heardIds = [];
    partner = "";
    officeAt = null;
    restartHeartbeat();
  }

  // ------------------------------------------------------------- the position

  /** Ask again from a click, which is where Android would rather be asked. */
  function askAgain() {
    askForPosition(setHere, {
      onTrouble: ({ kind, message }) => {
        fixTrouble = kind;
        pushLog(w().log.noFix(kind, message));
      },
    });
  }

  function setHere(fix) {
    // Whatever the browser was complaining about, it has stopped being true.
    if (fix.source === "browser") fixTrouble = null;
    // Which instrument to believe is one decision, made in one place, because
    // both map demos had the same wrong answer baked into them separately.
    const best = preferFix(here, fix);
    if (best === here) return;
    const moved = !here || here.lat !== best.lat || here.lon !== best.lon;
    here = best;
    if (moved) pushLog(w().log.position(best.source, formatPosition(best), best.accuracy));
  }

  // ------------------------------------------------------------ the heartbeat

  /**
   * What the jump bar offers, in the order the cards appear. The conditions
   * are the ones on the cards themselves — heard and track are the two arms
   * of one choice, so exactly one of them is ever here.
   */
  const jumps = $derived(
    [
      { id: "radio", label: t.jump.radio },
      { id: "role", label: t.jump.role },
      { id: "partner", label: t.jump.partner },
      { id: "where", label: t.jump.where },
      { id: "map", label: t.jump.map },
      role === "office"
        ? { id: "heard", label: t.jump.heard }
        : { id: "track", label: t.jump.track },
      showLog && { id: "log", label: t.jump.log },
    ].filter(Boolean),
  );

  /** Minutes between rounds, or null when only the button asks. */
  const roundEveryMs = $derived(
    role === "office" ? null : everyMin > 0 ? everyMin * 60_000 : null,
  );

  /**
   * How old a place may be and still be worth putting in a beat.
   *
   * One round, because a fix older than the gap between two rounds has already
   * been superseded by a round that said nothing about it. Two minutes when
   * nothing is on a timer.
   */
  const staleAfterMs = $derived(roundEveryMs ?? 120_000);


  async function startHeartbeat() {
    if (!courier || heartbeat) return;
    try {
      heartbeat = createHeartbeat({
        courier,
        tag: await databaseTag(ANYBODY),
        id: deviceId,
        minuteMs: beatGapMs,
        beatsPerRound: role === "office" ? 0 : BEATS_PER_ROUND,
        // The one that stays says where it is once and has nothing to add.
        // The one that moves says it on the first beat of every round, so the
        // far end holds the ride as well — fifteen bytes a round, and the half
        // most likely to lose its link is not the only copy.
        positionEvery: role === "office" ? "once" : "round",
        roundEveryMs,
        answerWindowMs,
        // Both devices say where they are; the rhythm above is the difference.
        // A rider's position changes, which is why it repeats it once a round
        // rather than once ever — and why it is not on every beat.
        // The library pulls a position when it wants one, so the freshness
        // check has to live here. A beat carries no time either: a place from
        // three rounds ago, sent as current, puts a point on the map where
        // this device used to be and files the answer against the wrong spot.
        // `pos` is optional in the protocol, so saying nothing is allowed.
        position: () =>
          holdStale && fixAgeMs(here) > staleAfterMs ? null : encodeNodePosition(here),
        // `lastError` is set when a send fails and cleared on the next one
        // that does not — so reading it here gives a transient message rather
        // than a banner that outlives the fault it describes.
        onChange: (state) => (beatState = state),
        onEvent: onBeatEvent,
      });
      heartbeat.start();
      pushLog(w().log.started(role === "office" ? w().role.office : w().role.rider));
    } catch (e) {
      error = e?.message ?? String(e);
      pushLog(w().log.error(error));
    }
  }

  /**
   * Stop and start, because role and interval are constructor arguments.
   *
   * The track survives it: what was recorded happened, whatever the device is
   * set to now. The lamps do not — they describe a heartbeat that is running,
   * and leaving them lit would report a beat from a round that no longer
   * exists.
   */
  function restartHeartbeat() {
    if (!heartbeat) return;
    heartbeat.stop();
    heartbeat = null;
    roundRunning = false;
    beatState = null;
    pingOut = null;
    pingIn = null;
    // Abandoned, not filed as a silence. A round cut short by a reconfigured
    // radio says nothing about the place it was sent from, and a red mark
    // there would be a measurement nobody made.
    track.abandon();
    refreshTrack();
    pushLog(w().log.stopped);
    startHeartbeat();
  }

  const describeError = (e) => e?.message ?? String(e);

  function onBeatEvent(event) {
    if (event.kind === "beat") {
      if (event.beat === 1) roundFailed = false;
      pingOut = { at: Date.now(), n: event.beat, of: event.of };
      roundRunning = true;
      // The position is read at the moment the beat goes out, not when the
      // answer comes back: the answer can be half a minute later, and on a
      // bicycle that is a different place.
      track.sent({ n: event.beat, of: event.of, position: here });
      refreshTrack();
      pushLog(w().log.beat(event.beat, event.of));
    }
    if (event.kind === "heard") {
      pingIn = {
        at: Date.now(),
        type: event.type,
        from: event.from,
        n: event.n,
        bytes: event.bytes,
      };
      if (!heardIds.includes(event.from)) heardIds = [...heardIds, event.from];
      heardLog.heard({
        type: event.type,
        from: event.from,
        n: event.n,
        bytes: event.bytes,
        position: event.pos
          ? decodeNodePosition({ latitudeI: event.pos[0], longitudeI: event.pos[1] })
          : null,
      });
      refreshHeard();
      pushLog(w().log.heard(event.type, event.from, event.n, event.bytes));
      const mine = !partner || event.from === partner;
      if (event.pos && mine) {
        const fix = decodeNodePosition({ latitudeI: event.pos[0], longitudeI: event.pos[1] });
        if (fix) {
          officeAt = { ...fix, source: "peer", from: event.from };
          pushLog(w().log.officePosition(formatPosition(officeAt)));
        }
      }
      // An echo answers a beat; another device's beat says it is there but
      // answers nothing of ours. Only the first closes a point — and only from
      // the device being measured against, when one has been named.
      if (event.type === "echo" && mine) {
        track.answered({ n: event.n, from: event.from });
        refreshTrack();
      }
    }
    if (event.kind === "echo") {
      // The lamp is "what this device last put on the air", and for the
      // stationary half that is only ever an echo. Without this it reads
      // "nothing sent yet" while it answers all day — indistinguishable from a
      // device that is not answering at all, which is the one thing the other
      // end needs to know.
      pingOut = { at: Date.now(), echo: true, to: event.to, n: event.n };
      heardLog.answered({ to: event.to, n: event.n });
      refreshHeard();
      pushLog(w().log.echo(event.to, event.n));
    }
    if (event.kind === "round") {
      // Fired whether the round was answered or not, which is exactly when the
      // button becomes useful again.
      roundRunning = false;
      // Close whatever beat is still open, either way. Usually that is the
      // last beat of a round nobody answered. It can also be a *later* beat in
      // a round that was answered by an earlier one — an echo slower than the
      // fifteen seconds to the next beat — and that beat is a silence of its
      // own rather than a row left waiting for an answer that will never come.
      // A round that could not transmit is not a measurement. Abandoned, so
      // the map does not grow a red mark for a place that was never asked.
      const stillOpen = roundFailed && !event.answered ? track.abandon() : track.unanswered();
      if (!event.answered) pushLog(roundFailed ? w().log.notAsked : w().log.alone);
      if (stillOpen || !event.answered) refreshTrack();
      roundFailed = false;
      refreshBudget();
    }
    // Logged only: `beatState.lastError` carries it on screen for as long as
    // it is still true, and the heartbeat clears that itself.
    if (event.kind === "error") {
      roundFailed = true;
      refreshBudget();
      pushLog(w().log.error(describeError(event.error)));
    }
  }

  const askNow = () => heartbeat?.beatNow();

  /**
   * Shared, and it reports being *dropped* because mesh-calendar was alone in
   * noticing that the browser takes the lock away when the page hides and
   * never gives it back.
   */
  const screenLock = createWakeLock({
    onEvent: (event) => {
      if (event.kind === "on") pushLog(w().log.wakeOn);
      if (event.kind === "off" || event.kind === "dropped") pushLog(w().log.wakeOff);
      if (event.kind === "refused") {
        keepAwake = false;
        pushLog(w().log.wakeRefused(event.reason));
      }
    },
  });

  async function toggleAwake() {
    await screenLock.set(!keepAwake);
    // What the lock says, not what the box was clicked to.
    keepAwake = screenLock.wanted();
    keep(AWAKE_KEY, keepAwake);
  }

  // A lock is dropped whenever the page is hidden, and comes back only if
  // something asks again. Without this, one glance at a messenger ends it.
  const reacquireOnReturn = () => {
    screenLock.reacquireIfWanted(document.visibilityState === "visible");
  };

  /**
   * Take the ride off the device.
   *
   * An hour of somebody's time and six minutes of a rationed band should not
   * be the most perishable thing in the experiment — until now a run lived on
   * the screen and in a screenshot, and a flat battery was the end of it.
   */
  function saveRide() {
    const text =
      role === "office"
        ? heardToCsv(heardLog.rows().slice().reverse())
        : rideToCsv(track.points(), { distance: distanceFromOffice });
    downloadText(rideFilename(role), text);
    pushLog(w().log.saved);
  }

  function clearTrack() {
    if (!confirm(w().track.confirmClear)) return;
    track.clear();
    heardLog.clear();
    refreshTrack();
    refreshHeard();
  }

  // --------------------------------------------------------------- the screen

  /** What a chosen interval costs, so the choice is not made blind. */
  const cost = $derived.by(() => {
    if (role === "office" || everyMin === 0) return null;
    const perRound = BEATS_PER_ROUND * BEAT_BYTES + POSITION_BYTES;
    const perHour = perRound * (60 / everyMin);
    return {
      perRound,
      perHour: perHour >= 1000 ? `${(perHour / 1000).toFixed(1)} kB` : `${perHour} B`,
      // 500 B a minute is what this carrier measured at — see the goodput
      // bench. A percentage of a measured number beats a percentage of a
      // regulation nobody can feel.
      share: Math.round((perHour / (500 * 60)) * 100),
    };
  });

  /** Null where the region has no duty cycle at all, which is not everywhere. */
  const budgetPercent = $derived(
    budget?.dutyCycle == null || !Number.isFinite(budget.remainingAirtimeMs)
      ? null
      : Math.max(
          0,
          Math.min(100, Math.round((budget.remainingAirtimeMs / (budget.dutyCycle * 3_600_000)) * 100)),
        ),
  );
  const airtimeBlocked = $derived(blockedForMs > 0);
  const untilFree = $derived(
    blockedForMs <= 0 ? "" : t.airtime.inMinutes(Math.max(1, Math.ceil(blockedForMs / 60_000))),
  );

  const distanceFromOffice = (point) =>
    point.position && officeAt ? distanceMetres(officeAt, point.position) : null;

  /**
   * What a row says happened.
   *
   * `waiting` is for a beat that is still in the air — which is why this asks
   * the round rather than the lamp. It used to compare against a fresh
   * `track.points()`, which hands out copies, so the comparison was never true
   * and a waiting row never said so; and `pingOut` stays lit after the round
   * is over, which would have left the last silence of every round claiming to
   * be waiting for an answer that had already been given up on.
   */
  const resultOf = (point) =>
    point.answered != null
      ? { text: t.track.answered(point.answered), kind: point.answered === 1 ? "first" : "late" }
      : point.answeredAt === null && point === rows[0] && roundRunning
        ? { text: t.track.waiting, kind: "open" }
        : { text: t.track.silent, kind: "silent" };

  /**
   * The ride, as the map wants it: oldest first, with a colour and a label.
   *
   * Both roles produce the same shape out of different records — the rider
   * from its own track, the stationary device from what reached it — because
   * the picture is the same ride and two screens showing it is the point.
   */
  const mapPoints = $derived.by(() => {
    if (role === "office") {
      return heardRows
        .filter((row) => row.position)
        .map((row) => ({
          lat: row.position.lat,
          lon: row.position.lon,
          at: row.at,
          kind: row.answered ? "first" : "silent",
          label: `${clockText(row.at)} · ${row.from ?? "?"} · ${
            here ? formatDistance(distanceMetres(here, row.position)) : ""
          }`,
        }))
        .reverse(); // heardRows is newest first; a ride is a line in time
    }
    return rows
      .filter((point) => point.position)
      .map((point) => ({
        lat: point.position.lat,
        lon: point.position.lon,
        at: point.at,
        kind: resultOf(point).kind,
        label: `${clockText(point.at)} · ${resultOf(point).text}${
          distanceFromOffice(point) == null
            ? ""
            : ` · ${formatDistance(distanceFromOffice(point))}`
        }`,
      }))
      .reverse();
  });

  /** The half that does not move: the other device for a rider, itself for an office. */
  const mapStation = $derived(role === "office" ? here : officeAt);

  onMount(() => {
    // Asked for again rather than assumed: a lock survives a launch only if
    // this browser still grants one, and the box follows the lock.
    if (kept(AWAKE_KEY, false)) {
      screenLock.set(true).then(() => (keepAwake = screenLock.wanted()));
    }
    // On a phone the console is invisible, and an exception in a handler or a
    // rejecting promise tears the connection down with nothing on screen to
    // act on. mesh-todo had this; the two demos most likely to be used away
    // from a desk did not (#191).
    stopWindowErrors = watchWindowErrors((type, message) =>
      pushLog(w().log.windowError(type, message)),
    );
    // The browser's fix is a fallback and starts straight away: waiting for
    // the node to prove it has no GPS would mean the first beats of a ride
    // have no place against them, and those are the ones taken at the office
    // where everything still works.
    stopWatchingBrowser = watchBrowserPosition(setHere, {
      onTrouble: ({ kind, message }) => {
        fixTrouble = kind;
        pushLog(w().log.noFix(kind, message));
      },
    });
    // Two seconds: slow enough to cost nothing, fast enough that "4 s ago"
    // reads as a thing that is still happening rather than a frozen label.
    tickTimer = setInterval(() => (nowTick = Date.now()), 2_000);
    // The fake mesh needs no permission and no chooser, so making it a button
    // press only costs a click — mesh-todo connects it on load for the same
    // reason. A real radio always waits for the gesture: Web Bluetooth
    // requires one, and so does anyone who did not mean to transmit.
    if (mode.kind === "bc" && params.get("autoconnect") !== "0") connect();
    document.addEventListener("visibilitychange", reacquireOnReturn);
    return () => {
      document.removeEventListener("visibilitychange", reacquireOnReturn);
      screenLock.release();
      stopWatchingBrowser?.();
      stopWindowErrors?.();
      if (tickTimer) clearInterval(tickTimer);
      if (budgetTimer) clearInterval(budgetTimer);
      heartbeat?.stop();
      radio?.close?.();
    };
  });
</script>

<main>
  <header>
    <h1>{t.title}</h1>
    <p class="tagline">{t.tagline}</p>
    <p class="intro">{@html t.intro}</p>
  </header>

  <!-- The radio first: everything below it is inert without one. -->
  <JumpBar items={jumps} label={t.jump.label} />

  <section class="card" id="radio">
    <h2>{t.radio.legend}</h2>
    <p class="status" data-testid="radio-status" data-phase={phase}>
      {#if phase === "ready"}
        <span class="dot ok" aria-hidden="true"></span>
        {linkKind === "bc" ? t.radio.fakeOn : t.radio.connected(region || "…")}
      {:else if phase === "connecting"}
        <span class="dot busy" aria-hidden="true"></span>{t.radio.connecting}
      {:else if phase === "lost"}
        <span class="dot bad" aria-hidden="true"></span>{t.radio.lost}
      {:else}
        <span class="dot" aria-hidden="true"></span>{t.radio.none}
      {/if}
      {#if reconnecting}<span class="dim"> · {t.radio.reconnecting}</span>{/if}
      {#if myNode}
        <!-- The four characters are what the device shows on its own screen,
             so they are what somebody holding two nodes can tell apart. -->
        <span class="dim"> · </span><strong data-testid="node-name">{myNode.shortName}</strong>
        <span class="dim mono" data-testid="node-id"> {myNode.id}</span>
        {#if myNode.longName}<span class="dim"> · {myNode.longName}</span>{/if}
      {/if}
    </p>
    {#if phase === "ready" && region === "UNSET"}
      <p class="warn" data-testid="region-unset">{t.radio.unset}</p>
    {/if}
    {#if phase !== "ready"}
      <button class="primary" data-testid="connect" onclick={connect} disabled={phase === "connecting"}>
        {mode.kind === "bc" ? t.radio.fake : t.radio.connect}
      </button>
    {/if}
    {#if error}<p class="warn mono" data-testid="radio-error">{error}</p>{/if}
    {#if beatState?.lastError}
      <!-- Live, not accumulated: gone as soon as a send succeeds. -->
      <p class="warn mono" data-testid="beat-error">{beatState.lastError}</p>
    {/if}
    {#if channels.length > 0}
      <p class="dim mono">
        <label class="row">
          {t.radio.channel}
          <select
            bind:value={txChannel}
            data-testid="tx-channel"
            onchange={() => {
              // A hand-made choice is final: nothing may move the selector
              // afterwards, or a late-arriving channel would silently undo it.
              const ch = channelBook.chooseByHand(txChannel);
              pushLog(w().log.handChannel(txChannel, ch?.name, ch?.fingerprint));
              changeChannel();
            }}
          >
            {#each channels as ch (ch.index)}
              <option value={ch.index}>{ch.index} · {ch.name} ⌗{ch.fingerprint}</option>
            {/each}
          </select>
        </label>
      </p>
    {/if}
    {#if budgetPercent != null}
      <div class="bar" title={t.airtime.title} data-testid="airtime-bar">
        <div class="fill" class:low={budgetPercent <= 15} style={`width:${budgetPercent}%`}></div>
      </div>
      <p class="dim" data-testid="airtime">
        {#if airtimeBlocked}
          <strong>{t.airtime.spent}</strong> {untilFree}
        {:else}
          {t.airtime.left(budgetPercent, budget.region)}
        {/if}
      </p>
    {/if}
    {#if airUtil != null}
      <p class="dim mono" data-testid="air-util">{t.radio.airUtil(airUtil.toFixed(1))}</p>
    {/if}
    {#if isMobileDevice && wakeLockSupported}
      <label class="row" title={t.radio.awakeWhy}>
        <input type="checkbox" bind:checked={keepAwake} data-testid="keep-awake" onchange={toggleAwake} />
        <span>{t.radio.awake}</span>
      </label>
    {/if}
    <label class="row">
      <input
        type="checkbox"
        bind:checked={holdStale}
        data-testid="hold-stale"
        onchange={() => keep(HOLD_STALE_KEY, holdStale)}
      />
      <span>
        {t.radio.holdStale}
        <small class="dim">{t.radio.holdStaleWhy}</small>
      </span>
    </label>
  </section>

  <!-- Role and interval are one decision in two halves: what this device does,
       and how often it does it. An office has no interval, which is why the
       second fieldset disappears rather than greying out — a control that
       cannot do anything is worse than no control. -->
  <section class="card" id="role">
    <fieldset data-testid="role">
      <legend>{t.role.legend}</legend>
      {#each [["rider", t.role.rider, t.role.riderWhy], ["office", t.role.office, t.role.officeWhy]] as [kind, label, why] (kind)}
        <label class="choice">
          <input
            type="radio"
            name="role"
            value={kind}
            checked={role === kind}
            data-testid="role-{kind}"
            onchange={() => {
              role = kind;
              keep(ROLE_KEY, kind);
              restartHeartbeat();
            }}
          />
          <span>
            <strong>{label}</strong>
            <small class="dim">{why}</small>
          </span>
        </label>
      {/each}
    </fieldset>

    {#if role === "rider"}
      <fieldset data-testid="interval">
        <legend>{t.interval.legend}</legend>
        <div class="intervals">
          {#each [0, 1, 2, 5] as min (min)}
            <label class="pill">
              <input
                type="radio"
                name="every"
                value={min}
                checked={everyMin === min}
                data-testid="every-{min}"
                onchange={() => {
                  everyMin = min;
                  keep(EVERY_KEY, min);
                  restartHeartbeat();
                }}
              />
              <span>{min === 0 ? t.interval.off : t.interval.minutes(min)}</span>
            </label>
          {/each}
        </div>
        {#if cost}
          <p class="dim mono" data-testid="interval-cost">
            {t.interval.cost(cost.perRound, cost.perHour, cost.share)}
          </p>
        {/if}
        <p class="dim">{t.interval.note}</p>
      </fieldset>

      <button
        class="primary"
        data-testid="ask-now"
        onclick={askNow}
        disabled={phase !== "ready" || !heartbeat || roundRunning || airtimeBlocked}
      >
        {t.send}
      </button>
    {/if}

    <!-- Two lamps, because one cannot answer the question. Out says a beat left
         and which of the round it was; in says something came back, from whom,
         answering which beat, and what it cost. -->
    <p class="lamps">
      <span class="lamp" data-testid="beat-out" data-lit={pingOut ? "yes" : "no"}>
        <span class="led out" aria-hidden="true"></span>
        <span>
          <strong>{pingOut?.echo ? t.led.outAnswer : t.led.out}</strong>
          <small>
            {#if !pingOut}{t.led.outIdle}
            {:else if pingOut.echo}{t.led.outEcho(pingOut.to, pingOut.n, clockText(pingOut.at))}
            {:else}{t.led.outAt(pingOut.n, pingOut.of, clockText(pingOut.at))}{/if}
          </small>
        </span>
      </span>
      <span class="lamp" data-testid="beat-in" data-lit={pingIn ? "yes" : "no"}>
        <span class="led in" aria-hidden="true"></span>
        <span>
          <strong>{t.led.in}</strong>
          <small>
            {pingIn
              ? t.led.inAt(pingIn.type, pingIn.from, pingIn.n, pingIn.bytes ?? "?", clockText(pingIn.at))
              : t.led.inIdle}
          </small>
        </span>
      </span>
    </p>
  </section>

  <!-- Whose answer counts. Last of the settings, because it only becomes a
       real question once something has answered — and first in importance the
       moment two parties share a channel. -->
  <section class="card" id="partner">
    <h2>{t.partner.legend}</h2>
    <label class="row">
      <select
        bind:value={partner}
        data-testid="partner"
        onchange={() => keep(PARTNER_KEY, partner)}
      >
        <option value="">{t.partner.anyone}</option>
        {#each heardIds as id (id)}
          <option value={id}>{id}</option>
        {/each}
      </select>
    </label>
    {#if summary.answerers > 1}
      <p class="warn" data-testid="channel-shared">{t.partner.shared(summary.answerers)}</p>
    {/if}
    <p class="dim small">{t.partner.hint}</p>
  </section>

  <section class="card" id="where">
    <h2>{t.where.legend}</h2>
    <p data-testid="here">
      {#if here}
        <span class="mono">{formatPosition(here)}</span>
        <span class="dim"> · {here.source === "node" ? t.where.node : t.where.browser}</span>
        {#if here.accuracy != null}
          <span class="dim"> · {t.where.accuracy(Math.round(here.accuracy))}</span>
        {/if}
        {#if here.at}
          <span class="dim"> · {t.where.age(Math.max(0, Math.round((nowTick - here.at) / 1000)))}</span>
        {/if}
      {:else}
        <span class="dim">{t.where.none} — {t.where.waiting}</span>
      {/if}
    </p>
    {#if fixTrouble && here?.source !== "node"}
      <p class="dim" data-testid="fix-trouble">{t.where.trouble[fixTrouble]}</p>
      {#if fixTrouble !== "unsupported"}
        <button class="quiet" data-testid="ask-position" onclick={askAgain}>{t.where.ask}</button>
      {/if}
    {/if}
    <p data-testid="office-at" class="dim">
      {#if officeAt}
        {t.where.office} <span class="mono">{formatPosition(officeAt)}</span>
        {#if here}
          <span class="dim"> · {formatDistance(distanceMetres(officeAt, here))}</span>
        {/if}
      {:else}
        {t.where.officeNone}
      {/if}
    </p>
  </section>

  <section class="card" id="map">
    <h2>{t.map.legend}</h2>
    {#if mapPoints.length === 0 && !mapStation && !here}
      <p class="dim" data-testid="map-empty">{t.map.empty}</p>
    {:else}
      <RideMap points={mapPoints} station={mapStation} {here} words={t.map} />
      <p class="dim">{t.map.note}</p>
    {/if}
  </section>

  {#if role === "office"}
    <!-- The stationary half's own record. Its "ride" is empty by definition —
         it sends no beats — and a summary line about a ride it was not on was
         the only thing this screen had to say about hours of answering. -->
    <section class="card" id="heard">
      <h2>{t.heard.legend}</h2>
      <p class="dim mono" data-testid="heard-summary">{t.heard.summary(heardSummary)}</p>
      {#if heardRows.length === 0}
        <p class="dim" data-testid="heard-empty">{t.heard.empty}</p>
      {:else}
        <div class="scroll">
          <table data-testid="heard">
            <thead>
              <tr>
                <th>{t.heard.columns.time}</th>
                <th>{t.heard.columns.from}</th>
                <th>{t.heard.columns.what}</th>
                <th>{t.heard.columns.bytes}</th>
                <th>{t.heard.columns.place}</th>
                <th>{t.heard.columns.distance}</th>
                <th>{t.heard.columns.answered}</th>
              </tr>
            </thead>
            <tbody>
              {#each heardRows as row}
                <tr data-result={row.type === "echo" ? "open" : row.answered ? "first" : "silent"}>
                  <td class="mono">{clockText(row.at)}</td>
                  <td class="mono dim">{row.from ?? "—"}</td>
                  <td class="mono">
                    {row.type === "echo" ? t.heard.foreign : t.heard.beat(row.n)}
                  </td>
                  <td class="mono">{row.bytes ?? "—"} B</td>
                  <td class="mono">{row.position ? formatPosition(row.position) : "—"}</td>
                  <td class="mono">
                    {(row.position && here && formatDistance(distanceMetres(here, row.position))) ||
                      "—"}
                  </td>
                  <td>{row.type === "echo" ? "—" : row.answered ? t.heard.yes : t.heard.no}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
        <p class="dim">{t.heard.note}</p>
        <button class="quiet" data-testid="save-ride" onclick={saveRide}>{t.heard.save}</button>
        <button class="quiet" data-testid="clear-track" onclick={clearTrack}>{t.heard.clear}</button>
      {/if}
    </section>
  {:else}
  <section class="card" id="track">
    <h2>{t.track.legend}</h2>
    <p class="dim mono" data-testid="track-summary">{t.track.summary(summary)}</p>
    {#if rows.length === 0}
      <p class="dim" data-testid="track-empty">{t.track.empty}</p>
    {:else}
      <div class="scroll">
        <table data-testid="track">
          <thead>
            <tr>
              <th>{t.track.columns.time}</th>
              <th>{t.track.columns.place}</th>
              <th>{t.track.columns.distance}</th>
              <th>{t.track.columns.result}</th>
              <th>{t.track.columns.by}</th>
            </tr>
          </thead>
          <tbody>
            {#each rows as point (point.at)}
              {@const result = resultOf(point)}
              <tr data-result={result.kind}>
                <td class="mono">{clockText(point.at)}</td>
                <td class="mono">{point.position ? formatPosition(point.position) : "—"}</td>
                <td class="mono">{formatDistance(distanceFromOffice(point)) || "—"}</td>
                <td>{result.text}</td>
                <td class="mono dim">{point.answeredBy ?? "—"}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
      <button class="quiet" data-testid="save-ride" onclick={saveRide}>{t.track.save}</button>
      <button class="quiet" data-testid="clear-track" onclick={clearTrack}>{t.track.clear}</button>
    {/if}
  </section>
  {/if}

  {#if showLog}
    <section class="card" id="log">
      <h2>{t.log.legend}</h2>
      <ol class="log mono" data-testid="log">
        {#each log as entry (entry.at + entry.line)}
          <li><span class="dim">{clockText(entry.at)}</span> {entry.line}</li>
        {/each}
      </ol>
    </section>
  {/if}

  <footer>
    <p class="dim mono">{t.footer(build)}</p>
    <p class="ls-credit">{@html creditHTML($lang)}</p>
  </footer>
</main>

<style>
  main {
    max-width: 46rem;
    margin: 0 auto;
    /* 64px at the top, as in the other demos: the brand pill is fixed at
       top: 16px and would otherwise sit across the title on a phone. */
    padding: 64px 1rem 4rem;
    display: flex;
    flex-direction: column;
    gap: 1.25rem;
    color: var(--ls-text);
    font-family: var(--ls-font);
  }
  h1 {
    font-size: clamp(1.4rem, 4vw, 2rem);
    margin: 0 0 0.25rem;
    text-wrap: balance;
  }
  h2 {
    font-size: 1rem;
    margin: 0 0 0.6rem;
    letter-spacing: 0.02em;
  }
  .tagline {
    margin: 0 0 0.75rem;
    color: var(--ls-text-dim);
  }
  .intro {
    margin: 0;
    color: var(--ls-text-dim);
    line-height: 1.55;
  }
  /* A jump must not put the heading under the bar it was made from. */
  section[id] {
    scroll-margin-top: 3.2rem;
  }

  .card {
    background: var(--ls-bg-2);
    border: 1px solid var(--ls-card-border);
    border-radius: var(--ls-radius);
    padding: 1rem;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }
  .dim {
    color: var(--ls-text-dim);
  }
  .mono {
    font-family: var(--ls-font-mono);
    font-variant-numeric: tabular-nums;
  }
  .warn {
    color: var(--ls-amber);
    margin: 0;
  }
  p {
    margin: 0;
  }

  /* The radio's state, as a dot plus words — the dot for a glance across a
     handlebar, the words for everything a colour cannot say. */
  .status {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
  }
  .dot {
    width: 0.7rem;
    height: 0.7rem;
    border-radius: 50%;
    background: var(--ls-text-faint);
    flex: none;
  }
  .dot.ok {
    background: var(--ls-green);
  }
  .dot.busy {
    background: var(--ls-amber);
  }
  .dot.bad {
    background: var(--ls-red);
  }

  fieldset {
    border: 1px solid var(--ls-card-border);
    border-radius: var(--ls-radius);
    padding: 0.75rem;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
  }
  legend {
    padding: 0 0.4rem;
    color: var(--ls-text-dim);
    font-size: 0.85rem;
  }
  .choice {
    display: flex;
    gap: 0.6rem;
    align-items: flex-start;
    cursor: pointer;
  }
  .choice span {
    display: flex;
    flex-direction: column;
    gap: 0.1rem;
  }
  .choice small {
    font-size: 0.85rem;
    line-height: 1.4;
  }

  .intervals {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }
  .pill {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    padding: 0.35rem 0.7rem;
    border: 1px solid var(--ls-card-border);
    border-radius: 999px;
    cursor: pointer;
  }
  .pill:has(input:checked) {
    border-color: var(--ls-accent);
    background: color-mix(in srgb, var(--ls-accent) 12%, transparent);
  }

  button {
    font: inherit;
    border-radius: 10px;
    padding: 0.6rem 1rem;
    border: 1px solid var(--ls-card-border);
    background: var(--ls-bg-1);
    color: var(--ls-text);
    cursor: pointer;
  }
  button.primary {
    background: var(--ls-red);
    border-color: transparent;
    color: #fff;
    font-weight: 600;
  }
  button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  button.quiet {
    align-self: flex-start;
    font-size: 0.85rem;
  }
  button:focus-visible,
  input:focus-visible {
    outline: 2px solid var(--ls-accent);
    outline-offset: 2px;
  }

  .lamps {
    display: flex;
    flex-wrap: wrap;
    gap: 1rem;
  }
  .bar {
    height: 0.4rem;
    border-radius: 0.2rem;
    background: color-mix(in srgb, currentColor 12%, transparent);
    overflow: hidden;
    margin: 0.6rem 0 0.3rem;
  }

  .fill {
    height: 100%;
    background: #34d399;
    transition: width 0.4s ease;
  }

  /* The last sixth of an hour's allowance, where the number stops being
     background information and starts deciding whether a ride continues. */
  .fill.low {
    background: #fbbf24;
  }

  .lamp {
    display: flex;
    gap: 0.5rem;
    align-items: center;
    flex: 1 1 14rem;
  }
  .lamp span {
    display: flex;
    flex-direction: column;
  }
  .lamp small {
    color: var(--ls-text-dim);
    font-size: 0.8rem;
    font-family: var(--ls-font-mono);
  }
  .led {
    width: 0.85rem;
    height: 0.85rem;
    border-radius: 50%;
    background: var(--ls-bg-3);
    flex: none;
    transition: background 0.2s;
  }
  .lamp[data-lit="yes"] .led.out {
    background: var(--ls-amber);
    box-shadow: 0 0 0.5rem var(--ls-amber);
  }
  .lamp[data-lit="yes"] .led.in {
    background: var(--ls-green);
    box-shadow: 0 0 0.5rem var(--ls-green);
  }

  .row {
    display: flex;
    gap: 0.5rem;
    align-items: center;
  }
  select {
    font: inherit;
    font-family: var(--ls-font-mono);
    padding: 0.4rem 0.6rem;
    border-radius: 10px;
    border: 1px solid var(--ls-card-border);
    background: var(--ls-bg-1);
    color: var(--ls-text);
  }
  .small {
    font-size: 0.85rem;
    line-height: 1.5;
  }
  .scroll {
    overflow-x: auto;
  }
  table {
    border-collapse: collapse;
    width: 100%;
    font-size: 0.85rem;
  }
  th,
  td {
    text-align: left;
    padding: 0.35rem 0.5rem;
    border-bottom: 1px solid var(--ls-card-border);
    white-space: nowrap;
  }
  th {
    color: var(--ls-text-dim);
    font-weight: 500;
  }
  tr[data-result="first"] td:last-child {
    color: var(--ls-green);
  }
  tr[data-result="late"] td:last-child {
    color: var(--ls-amber);
  }
  tr[data-result="silent"] td:last-child {
    color: var(--ls-red);
  }

  .log {
    margin: 0;
    padding-left: 1.2rem;
    max-height: 18rem;
    overflow-y: auto;
    font-size: 0.8rem;
    line-height: 1.6;
  }

  footer {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    font-size: 0.8rem;
  }

  @media (prefers-reduced-motion: reduce) {
    .led {
      transition: none;
    }
  }
</style>
