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
  import { connectCourier } from "@le-space/funkpost-radio";
  import {
    describeMeshtasticError,
    preferredChannelIndex,
    DEFAULT_PREFERRED_CHANNEL,
  } from "@le-space/funkpost";
  import { createHeartbeat } from "@le-space/funkpost/heartbeat";
  import { databaseTag } from "@le-space/orbitdb-storage-bridge/courier-sync";
  import { createCoverageTrack } from "./track.js";
  import {
    decodeNodePosition,
    encodeNodePosition,
    watchBrowserPosition,
    formatPosition,
    distanceMetres,
    formatDistance,
  } from "./position.js";
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
  let airUtil = $state(null);
  /** The heartbeat's own view of itself, including an error it clears again. */
  let beatState = $state(null);

  /** What this device does: answer and stay, or ask and travel. */
  let role = $state(params.get("role") === "office" ? "office" : "rider");
  /** Minutes between rounds; 0 is the button and nothing else. */
  let everyMin = $state(Number(params.get("every") ?? 2));

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
  let partner = $state(params.get("partner") ?? "");
  /** Every device heard so far, so the partner can be picked rather than typed. */
  let heardIds = $state([]);

  let pingOut = $state(null); // { at, n, of }
  let pingIn = $state(null); // { at, type, from, n, bytes }

  let rows = $state([]); // the track, newest first for the screen
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
  let txChannelChosenByHand = false;
  let preferenceApplied = false;
  const channelMap = new Map();
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
  let wakeSentinel = null;

  let courier = null;
  let radio = null;
  // $state, because the Ask-now button reads it: a plain variable would leave
  // the button disabled after the heartbeat had started.
  let heartbeat = $state(null);
  /** A round is in the air, so there is nothing for the button to ask. */
  let roundRunning = $state(false);
  let stopWatchingBrowser = null;
  const track = createCoverageTrack();

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

  // ---------------------------------------------------------------- the radio

  async function connect() {
    if (phase === "connecting" || phase === "ready") return;
    phase = "connecting";
    error = "";
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
      applyPreferredChannel();
      phase = "ready";
      startHeartbeat();
    } catch (e) {
      phase = "idle";
      error = describeMeshtasticError(e) ?? e?.message ?? String(e);
      pushLog(w().log.error(error));
    }
  }

  /** One channel as the node reports it. Named, so a test can hand one over. */
  async function handleChannel(channel) {
    if (channel.role === 0) return; // DISABLED
    const psk = channel.settings?.psk ?? new Uint8Array();
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", psk));
    const entry = {
      index: channel.index,
      role: channel.role,
      name: channel.settings?.name || "(default)",
      fingerprint: [...digest.slice(0, 2)].map((b) => b.toString(16).padStart(2, "0")).join(""),
    };
    channelMap.set(entry.index, entry);
    channels = [...channelMap.values()].sort((a, b) => a.index - b.index);
    if (entry.role === 1) primaryChannel = { name: entry.name, fingerprint: entry.fingerprint };
    pushLog(w().log.nodeChannel(entry.index, entry.name, entry.fingerprint));
    // Channels arrive one at a time and the wanted one need not be first.
    applyPreferredChannel();
  }

  /**
   * Only ever moves off a channel nobody chose.
   *
   * This matters more here than in the other demos: two devices measuring each
   * other must be on the same channel, and the index is per device, so a name
   * is the only thing they can agree on without the operator comparing numbers
   * at the kerb.
   */
  function applyPreferredChannel() {
    if (preferenceApplied || txChannelChosenByHand) return;
    const index = preferredChannelIndex(channels, preferredChannel);
    if (index == null) return;
    preferenceApplied = true;
    txChannel = index;
    setTxChannelFn(index);
    const ch = channels.find((c) => c.index === index);
    pushLog(w().log.autoChannel(index, ch?.name, ch?.fingerprint));
    // Another channel is another audience: what answered on the old one is no
    // evidence about this one, and the track would be measuring two things.
    changeChannel();
  }

  /** A channel change invalidates everything heard so far. */
  function changeChannel() {
    heardIds = [];
    partner = "";
    officeAt = null;
    restartHeartbeat();
  }

  // ------------------------------------------------------------- the position

  function setHere(fix) {
    // The node wins. A browser fix that arrives after one from the node is the
    // phone's opinion about a place the antenna already reported, and mixing
    // the two silently is how a track ends up with two accuracies and no note
    // of which is which.
    if (here?.source === "node" && fix.source === "browser") return;
    const moved = !here || here.lat !== fix.lat || here.lon !== fix.lon;
    here = fix;
    if (moved) pushLog(w().log.position(fix.source, formatPosition(fix)));
  }

  // ------------------------------------------------------------ the heartbeat

  /** Minutes between rounds, or null when only the button asks. */
  const roundEveryMs = $derived(
    role === "office" ? null : everyMin > 0 ? everyMin * 60_000 : null,
  );

  async function startHeartbeat() {
    if (!courier || heartbeat) return;
    try {
      heartbeat = createHeartbeat({
        courier,
        tag: await databaseTag(ANYBODY),
        id: deviceId,
        minuteMs: beatGapMs,
        beatsPerRound: role === "office" ? 0 : BEATS_PER_ROUND,
        roundEveryMs,
        answerWindowMs,
        // Only the stationary device announces where it is, and only once.
        // A rider's position changes every beat, so putting it on the wire
        // would cost fifteen bytes a beat to say something already recorded
        // on the device that cares about it.
        position: () => (role === "office" ? encodeNodePosition(here) : null),
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
    if (event.kind === "echo") pushLog(w().log.echo(event.to, event.n));
    if (event.kind === "round") {
      // Fired whether the round was answered or not, which is exactly when the
      // button becomes useful again.
      roundRunning = false;
      if (!event.answered) {
        track.unanswered();
        refreshTrack();
        pushLog(w().log.alone);
      }
    }
    // Logged only: `beatState.lastError` carries it on screen for as long as
    // it is still true, and the heartbeat clears that itself.
    if (event.kind === "error") pushLog(w().log.error(describeError(event.error)));
  }

  const askNow = () => heartbeat?.beatNow();

  async function acquireWakeLock() {
    try {
      wakeSentinel = await navigator.wakeLock.request("screen");
      wakeSentinel.addEventListener("release", () => (wakeSentinel = null));
      pushLog(w().log.wakeOn);
    } catch (e) {
      keepAwake = false;
      pushLog(w().log.wakeRefused(describeError(e)));
    }
  }

  async function toggleAwake() {
    if (keepAwake) await acquireWakeLock();
    else {
      await wakeSentinel?.release();
      wakeSentinel = null;
      pushLog(w().log.wakeOff);
    }
  }

  // A lock is dropped whenever the page is hidden, and comes back only if
  // something asks again. Without this, one glance at a messenger ends it.
  const reacquireOnReturn = () => {
    if (keepAwake && document.visibilityState === "visible" && !wakeSentinel) acquireWakeLock();
  };

  function clearTrack() {
    if (!confirm(w().track.confirmClear)) return;
    track.clear();
    refreshTrack();
  }

  // --------------------------------------------------------------- the screen

  /** What a chosen interval costs, so the choice is not made blind. */
  const cost = $derived.by(() => {
    if (role === "office" || everyMin === 0) return null;
    const perRound = BEATS_PER_ROUND * BEAT_BYTES;
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

  const distanceFromOffice = (point) =>
    point.position && officeAt ? distanceMetres(officeAt, point.position) : null;

  const resultOf = (point) =>
    point.answered != null
      ? { text: t.track.answered(point.answered), kind: point.answered === 1 ? "first" : "late" }
      : point.answeredAt === null && point === track.points().at(-1) && pingOut
        ? { text: t.track.waiting, kind: "open" }
        : { text: t.track.silent, kind: "silent" };

  onMount(() => {
    // The browser's fix is a fallback and starts straight away: waiting for
    // the node to prove it has no GPS would mean the first beats of a ride
    // have no place against them, and those are the ones taken at the office
    // where everything still works.
    stopWatchingBrowser = watchBrowserPosition(setHere);
    // The fake mesh needs no permission and no chooser, so making it a button
    // press only costs a click — mesh-todo connects it on load for the same
    // reason. A real radio always waits for the gesture: Web Bluetooth
    // requires one, and so does anyone who did not mean to transmit.
    if (mode.kind === "bc" && params.get("autoconnect") !== "0") connect();
    document.addEventListener("visibilitychange", reacquireOnReturn);
    return () => {
      document.removeEventListener("visibilitychange", reacquireOnReturn);
      wakeSentinel?.release();
      stopWatchingBrowser?.();
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
  <section class="card">
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
              txChannelChosenByHand = true;
              setTxChannelFn(txChannel);
              const ch = channels.find((c) => c.index === txChannel);
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
    {#if airUtil != null}
      <p class="dim mono" data-testid="air-util">{t.radio.airUtil(airUtil.toFixed(1))}</p>
    {/if}
    {#if isMobileDevice && wakeLockSupported}
      <label class="row" title={t.radio.awakeWhy}>
        <input type="checkbox" bind:checked={keepAwake} data-testid="keep-awake" onchange={toggleAwake} />
        <span>{t.radio.awake}</span>
      </label>
    {/if}
  </section>

  <!-- Role and interval are one decision in two halves: what this device does,
       and how often it does it. An office has no interval, which is why the
       second fieldset disappears rather than greying out — a control that
       cannot do anything is worse than no control. -->
  <section class="card">
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
        disabled={phase !== "ready" || !heartbeat || roundRunning}
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
          <strong>{t.led.out}</strong>
          <small>{pingOut ? t.led.outAt(pingOut.n, pingOut.of, clockText(pingOut.at)) : t.led.outIdle}</small>
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
  <section class="card">
    <h2>{t.partner.legend}</h2>
    <label class="row">
      <select bind:value={partner} data-testid="partner">
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

  <section class="card">
    <h2>{t.where.legend}</h2>
    <p data-testid="here">
      {#if here}
        <span class="mono">{formatPosition(here)}</span>
        <span class="dim"> · {here.source === "node" ? t.where.node : t.where.browser}</span>
      {:else}
        <span class="dim">{t.where.none} — {t.where.waiting}</span>
      {/if}
    </p>
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

  <section class="card">
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
      <button class="quiet" data-testid="clear-track" onclick={clearTrack}>{t.track.clear}</button>
    {/if}
  </section>

  {#if showLog}
    <section class="card">
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
