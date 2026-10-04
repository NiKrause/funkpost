<!-- SPDX-License-Identifier: GPL-3.0-only -->
<!--
  Everyone on one map.

  A walk with radios. Each device says where it is on a schedule, every other
  device hears it and draws the trail, and two fixes are a direction. No
  database anywhere — the whole import list is a radio, a beacon and a map.

  THE GROUP SIZE IS A PARAMETER, which is new here. A beacon is 49 bytes with
  a good fix, about half a second of air at LONG_FAST. Per device at one a
  minute that is well under 1 % duty cycle and the law is nowhere near binding
  — but the *channel* is shared and LoRa has no collision avoidance:

    2 people   every minute  20 %     every 2 min  10 %     every 5 min   4 %
    5 people   every minute  49 %     every 2 min  25 %     every 5 min  10 %
   10 people   every minute  98 %     every 2 min  49 %     every 5 min  20 %

  (of the ~500 B a minute this carrier was measured to move). ALOHA-shaped
  media lose to collisions long before they are full, so the interval follows
  the group size and the page shows what the choice costs — with the count of
  devices actually heard, not a guess.

  SENDING IS OFF UNTIL SOMEBODY TURNS IT ON. This is a page that broadcasts a
  live position, which is a different thing from a beat: on the published test
  channel the key is on a web page, so anyone who has read it can watch a walk
  happen. Listening needs no permission from anybody and is the default.

  Names are local. A device is four bytes on the air and whatever somebody
  typed on this phone, and the second never leaves it.
-->
<script>
  import { onMount } from "svelte";
  import { creditHTML, lang } from "@le-space/funkpost-brand";
  import { connectCourier, watchWindowErrors } from "@le-space/funkpost-radio";
  import { createChannelBook } from "@le-space/funkpost-radio/channels.js";
  import { createWakeLock } from "@le-space/funkpost-radio/wake-lock.js";
  import JumpBar from "@le-space/funkpost-radio/JumpBar.svelte";
  import {
    decodeNodePosition,
    preferFix,
    freshPosition,
    fixAgeMs,
    encodeNodePosition,
    watchBrowserPosition,
    askForPosition,
    formatPosition,
    distanceMetres,
    formatDistance,
    bearingDegrees,
    compassPoint,
  } from "@le-space/funkpost-radio/position.js";
  import {
    describeMeshtasticError,
    DEFAULT_PREFERRED_CHANNEL,
  } from "@le-space/funkpost";
  import {
    encodeBeacon,
    decodeBeacon,
    sameGroup,
    groupAirtime,
    STATES,
  } from "@le-space/funkpost/beacon";
  import { databaseTag } from "@le-space/orbitdb-storage-bridge/courier-sync";
  import { createPeers } from "./peers.js";
  import TrailMap from "./TrailMap.svelte";
  import { WORDS } from "./words.js";

  const t = $derived(WORDS[$lang]);
  const w = () => WORDS[lang.get()];
  $effect(() => {
    document.title = t.title;
  });

  const params = new URLSearchParams(location.search);

  /**
   * The group, as a name nobody has to type the same way twice.
   *
   * Hashed to eight bytes, so the name itself never goes on the air — and a
   * group that wants its own can pass `?group=`, which is cheaper than a
   * second channel when the point is only to stop two walks drawing each
   * other.
   */
  const GROUP = params.get("group") || "funkpost/where-is-everyone/1";

  /** The published test channel, whose key is on a web page. */
  const PUBLIC_CHANNEL_PRINT = "3dd3";

  /**
   * One colour per device, in the order they were first drawn.
   *
   * Chosen to stay apart on a map that is mostly green and grey, and to remain
   * distinguishable for the commonest colour-blindness — which rules out the
   * red/green pairing a walk would otherwise reach for first.
   */
  const TRAIL_COLOURS = ["#38bdf8", "#fbbf24", "#c084fc", "#34d399", "#fb923c", "#f472b6"];

  const mode =
    params.get("mesh") === "bc"
      ? {
          kind: "bc",
          room: params.get("room") ?? "mesh-trail",
          loss: Number(params.get("loss") ?? 0),
          preset: params.get("preset") ?? undefined,
        }
      : { kind: "ble" };

  const showLog = params.get("log") === "1";

  /**
   * This device's name on the air: four bytes, kept across sessions.
   *
   * Stable rather than random per session, chosen deliberately: a walk that
   * reloads a phone should not turn that person into a stranger with a fresh
   * trail. The cost is honest and worth stating — a stable identifier on a
   * shared channel is something an observer can follow across days. It is four
   * random bytes and nothing else: no name, no device model, nothing derived
   * from hardware.
   */
  const ID_KEY = "mesh-trail:id:v1";
  const PREFS_KEY = "mesh-trail:peers:v1";

  /**
   * Per device when there is a radio; per tab when there is not.
   *
   * mesh-todo settled this one already, for the same reason: two tabs must be
   * two peers, because the two-tab rehearsal is how anybody tries this without
   * hardware. Two tabs share `localStorage`, so a stable identity there makes
   * them one device — and each would then drop the other's beacons as its own
   * and draw an empty map while the log says both are sending.
   *
   * With a real radio a tab is a device and the identity is kept across
   * sessions, which is what was asked for: a walk that reloads a phone should
   * not turn that person into a stranger with a fresh trail.
   */
  const idStore = () => (mode.kind === "bc" ? sessionStorage : localStorage);

  function keepId() {
    try {
      const kept = idStore().getItem(ID_KEY);
      if (kept && /^[0-9a-f]{8}$/.test(kept)) {
        return Uint8Array.from(kept.match(/../g).map((b) => parseInt(b, 16)));
      }
    } catch {
      // A browser that refuses storage gets a new name every launch, which is
      // worse company on a walk but not a reason to fail.
    }
    const fresh = crypto.getRandomValues(new Uint8Array(4));
    try {
      idStore().setItem(ID_KEY, [...fresh].map((b) => b.toString(16).padStart(2, "0")).join(""));
    } catch {
      /* as above */
    }
    return fresh;
  }

  const myId = keepId();
  const myName = [...myId].map((b) => b.toString(16).padStart(2, "0")).join("");

  let phase = $state("idle"); // idle → connecting → ready | lost
  let linkKind = $state("");
  let region = $state("");
  let error = $state("");
  let reconnecting = $state(false);
  let airUtil = $state(null);
  let myNodeNum = $state(null);
  /** Which node this is: its four display characters and its !id. */
  let myNode = $state(null);

  let radio = null;
  let courier = null;
  let tag = null;
  let setTxChannelFn = () => {};

  // Which channel the radio transmits on. The index is per device — the same
  // channel can be 1 here and 3 there — so the preference is by name, and the
  // page moves itself onto it once the node has reported it.
  const preferredChannel = params.has("channel")
    ? params.get("channel")
    : DEFAULT_PREFERRED_CHANNEL;
  let channels = $state([]);
  let txChannel = $state(0);
  let primaryChannel = $state(null);

  /** Where this device is, and what the browser says when it has none. */
  let here = $state(null);
  let fixTrouble = $state(null);
  let stopWatchingBrowser = null;
  let stopWindowErrors = null;
  let nowTick = $state(Date.now());
  let tickTimer = null;

  /** Off until somebody turns it on. Listening asks nobody's permission. */
  let broadcasting = $state(false);
  let publicAccepted = $state(false);
  let everyMin = $state(Number(params.get("every") ?? 2));
  let beaconTimer = null;
  let lastSentAt = $state(null);
  /** Seconds of age that held the last beacon back, or null when none did. */
  let heldBack = $state(null);

  /**
   * How this device is, which a schedule cannot say.
   *
   * Sticky rather than one-shot: "I am stopping here" stays true until it is
   * not, and a walk where somebody has to keep pressing a button to remain
   * stopped is a walk nobody presses the button on. `ok` is the default and
   * costs nothing on the wire.
   */
  let myState = $state("ok");
  /** The hunted one, in a game. Absent for everyone else, including on the air. */
  let amFox = $state(false);
  /** Whose bearing the compass is showing, or the fox when there is a hunt. */
  let following = $state("");

  /**
   * What this page shows. Everything optional, because a walk and a bench want
   * different screens — and in a wood, a page that fits on one screen is a page
   * somebody reads.
   */
  const SHOW_KEY = "mesh-trail:show:v1";
  let show = $state({ map: true, trails: true, people: true, compass: true, checkIn: true, hunt: false });

  const peers = createPeers();
  let peerRows = $state([]);
  let peerSummary = $state({ heard: 0, shown: 0, moving: 0 });

  let log = $state([]);
  let keepAwake = $state(false);

  const build = __BUILD_INFO__;

  const clockText = (at) =>
    at == null ? "" : new Date(at).toLocaleTimeString(undefined, { hour12: false });

  function pushLog(line) {
    log = [...log.slice(-199), { at: Date.now(), line }];
  }

  const refreshPeers = () => {
    peerRows = peers.list();
    peerSummary = peers.summary();
  };

  /** Names and switches, kept on this device and nowhere else. */
  function savePreferences() {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(peers.preferences()));
    } catch {
      /* a browser that refuses storage simply forgets the names */
    }
  }

  function loadPreferences() {
    try {
      const kept = JSON.parse(localStorage.getItem(PREFS_KEY) ?? "[]");
      if (Array.isArray(kept)) peers.restore(kept);
    } catch {
      /* as above */
    }
  }
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
          if (wasUnusable && name && name !== "UNSET") restartBeacons();
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
      startBeacons();
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

  /**
    * A channel change invalidates everything heard so far.
    *
    * Another channel is another audience: the people on the old one are not
    * out of range, they are out of earshot, and leaving their trails on the
    * map would be drawing a walk nobody is on.
    */
  function changeChannel() {
    peers.clear();
    refreshPeers();
    restartBeacons();
  }

  /**
   * What the jump bar offers, in the order the cards appear.
   *
   * The conditions are the ones on the cards themselves, which is the one
   * place this can drift. A link to a card that is switched off would do
   * nothing rather than break, but it would still be a lie about the page.
   */
  const jumps = $derived(
    [
      { id: "radio", label: t.jump.radio },
      { id: "broadcast", label: t.jump.broadcast },
      broadcasting && { id: "interval", label: t.jump.interval },
      { id: "show", label: t.jump.show },
      show.checkIn && { id: "check-in", label: t.jump["check-in"] },
      show.hunt && { id: "hunt", label: t.jump.hunt },
      show.compass && { id: "compass", label: t.jump.compass },
      { id: "where", label: t.jump.where },
      show.map && { id: "map", label: t.jump.map },
      show.people && { id: "people", label: t.jump.people },
    ].filter(Boolean),
  );

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

  // -------------------------------------------------------------- the beacons

  /**
   * Hearing is unconditional; saying is not.
   *
   * The courier is subscribed the moment there is one, whether or not this
   * device ever transmits. That is the shape of the thing: a page that only
   * listens is a perfectly good member of a walk, and it asks nobody's
   * permission to be one.
   */
  async function startBeacons() {
    if (!courier || tag) return;
    try {
      tag = await databaseTag(GROUP);
    } catch (e) {
      error = describeMeshtasticError(e) ?? e?.message ?? String(e);
      return;
    }
    courier.onPayload((bytes) => {
      const message = decodeBeacon(bytes);
      // Another protocol on this channel — a heartbeat, a founding pointer, a
      // delta — is not an error and not worth a line in a field log.
      if (!message) return;
      if (!sameGroup(message, tag)) return;
      const from = [...message.from].map((b) => b.toString(16).padStart(2, "0")).join("");
      // A node that hands a device its own frames back is a thing that
      // happens, and drawing a trail of oneself is a confusing way to find out.
      if (from === myName) return;
      const fix = decodeNodePosition({ latitudeI: message.pos[0], longitudeI: message.pos[1] });
      if (!fix) return;
      peers.heard({
        from,
        pos: fix,
        accuracy: message.accuracy,
        state: message.state,
        role: message.role,
      });
      refreshPeers();
      pushLog(w().log.heard(from, bytes.length));
    });
    scheduleBeacons();
  }

  /**
   * How old a place may be and still be worth saying.
   *
   * The beacon carries no time, so whatever goes out is read as current by
   * everyone who hears it. One interval is the honest ceiling: a fix older
   * than the gap between two beacons has already been superseded by a beacon
   * that never happened. Two minutes when nothing is on a timer and the button
   * is the only sender.
   */
  const staleAfterMs = $derived(everyMin > 0 ? everyMin * 60_000 : 120_000);

  function restartBeacons() {
    tag = null;
    if (beaconTimer) clearInterval(beaconTimer);
    beaconTimer = null;
    startBeacons();
  }

  /** The schedule, which exists only while this device is saying anything. */
  function scheduleBeacons() {
    if (beaconTimer) clearInterval(beaconTimer);
    beaconTimer = null;
    if (!broadcasting || everyMin <= 0) return;
    beaconTimer = setInterval(sayWhereIAm, everyMin * 60_000);
    sayWhereIAm();
  }

  /**
   * One beacon, now.
   *
   * Fire and forget: no acknowledgement, no retry. A position that missed is
   * replaced by the next one, which is a better answer than resending a place
   * somebody has already walked away from — and in a group a retry multiplies
   * traffic by the number of listeners.
   */
  async function sayWhereIAm() {
    if (!courier || !tag) return;
    // Ask before saying. `watchPosition` reports changes, not time, so a
    // phone that has been still — or a page that was in the background — holds
    // a fix from minutes ago, and the beacon has no field to admit that in.
    const asked = await freshPosition();
    if (asked) setHere(asked);
    if (!here) return;

    const age = fixAgeMs(here);
    if (age > staleAfterMs) {
      // Saying nothing is the honest option: a stale place broadcast as a
      // current one puts the other walker's compass on a bearing to where
      // this device used to be.
      heldBack = Math.round(age / 1000);
      pushLog(w().log.heldBack(heldBack));
      return;
    }
    heldBack = null;

    const pos = encodeNodePosition(here);
    if (!pos) return;
    const bytes = encodeBeacon({
      tag,
      from: myId,
      pos,
      accuracy: here.accuracy ?? null,
      state: myState,
      role: amFox ? "fox" : null,
    });
    lastSentAt = Date.now();
    courier.send(bytes).then(
      () => pushLog(w().log.sent(bytes.length)),
      (e) => pushLog(w().log.error(describeMeshtasticError(e) ?? e?.message ?? String(e))),
    );
  }

  function toggleBroadcast() {
    if (!broadcasting && onPublicChannel && !publicAccepted) return;
    broadcasting = !broadcasting;
    pushLog(broadcasting ? w().log.broadcastOn : w().log.broadcastOff);
    scheduleBeacons();
  }

  /**
   * A check-in, which is the reason a schedule is not enough.
   *
   * Said immediately as well as kept: the whole point of pressing *come here*
   * is that it does not wait two minutes. Pressing the state this device is
   * already in clears it back to ok, so the same button both says and unsays.
   */
  function checkIn(state) {
    myState = myState === state ? "ok" : state;
    pushLog(w().log.checkIn(myState));
    if (broadcasting) sayWhereIAm();
  }

  function toggleFox() {
    amFox = !amFox;
    pushLog(amFox ? w().log.foxOn : w().log.foxOff);
    if (broadcasting) sayWhereIAm();
  }

  function saveShown() {
    try {
      localStorage.setItem(SHOW_KEY, JSON.stringify(show));
    } catch {
      /* a browser that refuses storage simply forgets the layout */
    }
  }

  function loadShown() {
    try {
      const kept = JSON.parse(localStorage.getItem(SHOW_KEY) ?? "null");
      if (kept && typeof kept === "object") show = { ...show, ...kept };
    } catch {
      /* as above */
    }
  }

  function chooseInterval(minutes) {
    everyMin = minutes;
    scheduleBeacons();
  }

  // ------------------------------------------------------------ who is around

  function renamePeer(id, name) {
    peers.name(id, name);
    savePreferences();
    refreshPeers();
  }

  function togglePeer(id, shown) {
    peers.show(id, shown);
    savePreferences();
    refreshPeers();
  }

  function forgetPeer(id) {
    if (!confirm(w().people.confirmForget)) return;
    peers.forget(id);
    savePreferences();
    refreshPeers();
  }

  // --------------------------------------------------------------- the screen

  /** The channel whose key is published, recognised by its fingerprint. */
  const onPublicChannel = $derived(
    channels.find((c) => c.index === txChannel)?.fingerprint === PUBLIC_CHANNEL_PRINT,
  );

  /**
   * What this group costs at this interval.
   *
   * Counted from the devices actually heard plus this one, so the number
   * changes as people arrive rather than describing a group somebody guessed
   * at when they opened the page.
   */
  const cost = $derived.by(() => {
    if (everyMin <= 0) return null;
    const people = peerSummary.heard + 1;
    const air = groupAirtime({ people, everyMin });
    return air ? { people, ...air } : null;
  });

  const crowded = $derived((cost?.share ?? 0) >= 50);

  /** Oldest first for the line, so the brighter end is the newer one. */
  const trails = $derived(
    peerRows
      .filter((p) => p.shown && p.points.length > 0)
      .map((p, index) => ({
        id: p.id,
        name: p.name || p.id,
        colour: TRAIL_COLOURS[index % TRAIL_COLOURS.length],
        // With trails off the map keeps only the newest place: where
        // everybody is, without where they have been. On a small screen that
        // is sometimes the whole question.
        points: show.trails ? p.points : p.points.slice(-1),
        state: p.state,
        role: p.role,
      })),
  );

  const colourOf = (id) => {
    const index = trails.findIndex((p) => p.id === id);
    return index === -1 ? null : trails[index].colour;
  };

  const lastPoint = (peer) => peer.points.at(-1) ?? null;

  /** The fox when there is a hunt, otherwise whoever was picked. */
  const followed = $derived.by(() => {
    const hunted = show.hunt ? peerRows.find((p) => p.role === "fox") : null;
    return hunted ?? peerRows.find((p) => p.id === following) ?? null;
  });

  /**
   * Where to walk, when the map will not load.
   *
   * The age is not decoration: a bearing to a ten-minute-old position in a
   * wood points at somewhere nobody is, and the number is the only thing that
   * says so.
   */
  const compass = $derived.by(() => {
    const peer = followed;
    const point = peer && lastPoint(peer);
    if (!peer || !point || !here) return null;
    return {
      id: peer.id,
      name: peer.name || peer.id,
      degrees: bearingDegrees(here, point),
      metres: distanceMetres(here, point),
      at: point.at,
    };
  });

  const headingOf = (peer) => {
    if (peer.points.length < 2) return null;
    return bearingDegrees(peer.points.at(-2), peer.points.at(-1));
  };

  const distanceOf = (peer) => {
    const point = lastPoint(peer);
    return point && here ? distanceMetres(here, point) : null;
  };

  const ageText = (at) =>
    at == null ? "" : t.where.age(Math.max(0, Math.round((nowTick - at) / 1000)));
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
    keepAwake = !keepAwake;
    await screenLock.set(keepAwake);
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

  onMount(() => {
    // On a phone the console is invisible, and an exception during mount takes
    // the page with it.
    stopWindowErrors = watchWindowErrors((type, message) =>
      pushLog(w().log.windowError(type, message)),
    );
    loadPreferences();
    loadShown();
    refreshPeers();
    // The browser's fix starts straight away and says what it is doing when
    // there is none — on a walk, "still searching" and "blocked" are different
    // problems and only one of them is solved by waiting.
    stopWatchingBrowser = watchBrowserPosition(setHere, {
      onTrouble: ({ kind, message }) => {
        fixTrouble = kind;
        pushLog(w().log.noFix(kind, message));
      },
    });
    tickTimer = setInterval(() => (nowTick = Date.now()), 2_000);
    // The fake mesh needs no permission and no chooser.
    if (mode.kind === "bc" && params.get("autoconnect") !== "0") connect();

    const reacquireOnReturn = () => {
      screenLock.reacquireIfWanted(document.visibilityState === "visible");
    };
    document.addEventListener("visibilitychange", reacquireOnReturn);
    return () => {
      document.removeEventListener("visibilitychange", reacquireOnReturn);
      screenLock.release();
      stopWatchingBrowser?.();
      stopWindowErrors?.();
      if (tickTimer) clearInterval(tickTimer);
      if (beaconTimer) clearInterval(beaconTimer);
      radio?.close?.();
    };
  });
</script>

<main>
  <header>
    <h1>{t.title}</h1>
    <p class="dim">{t.tagline}</p>
    <p>{t.intro}</p>
  </header>

  <JumpBar items={jumps} label={t.jump.label} />

  <section class="card" id="radio">
    <h2>{t.radio.legend}</h2>
    <p data-testid="radio-status" data-phase={phase}>
      <span class="dot" data-phase={phase}></span>
      {#if phase === "ready"}
        {linkKind === "bc" ? t.radio.fakeOn : t.radio.connected(region || "?")}
      {:else if phase === "connecting"}
        {t.radio.connecting}
      {:else if phase === "lost"}
        {t.radio.lost}
      {:else}
        {t.radio.none}
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
    {#if error}<p class="bad" data-testid="radio-error">{error}</p>{/if}
    {#if phase === "idle" || phase === "lost"}
      <button class="primary" data-testid="connect" onclick={connect}>
        {mode.kind === "bc" ? t.radio.fake : t.radio.connect}
      </button>
    {/if}
    {#if channels.length > 0}
      <p>
        <label>
          {t.radio.channel}
          <select
            data-testid="channel"
            value={txChannel}
            onchange={(e) => {
              txChannel = Number(e.currentTarget.value);
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
    {#if airUtil != null}
      <p class="dim mono" data-testid="air-util">{t.radio.airUtil(airUtil.toFixed(1))}</p>
    {/if}
    <p>
      <label>
        <input type="checkbox" checked={keepAwake} onchange={toggleAwake} data-testid="awake" />
        {t.radio.awake}
      </label>
    </p>
    <p class="dim">{t.radio.awakeWhy}</p>
  </section>

  <section class="card" id="broadcast">
    <h2>{t.broadcast.legend}</h2>
    {#if onPublicChannel && !broadcasting}
      <p class="warn" data-testid="public-warning">{t.broadcast.publicWarning}</p>
      <p>
        <label>
          <input
            type="checkbox"
            checked={publicAccepted}
            onchange={(e) => (publicAccepted = e.currentTarget.checked)}
            data-testid="accept-public"
          />
          {t.broadcast.publicAsk}
        </label>
      </p>
      <p class="dim">{t.broadcast.ownChannel}</p>
    {/if}
    <p>
      <label>
        <input
          type="checkbox"
          checked={broadcasting}
          disabled={phase !== "ready" || (onPublicChannel && !publicAccepted && !broadcasting)}
          onchange={toggleBroadcast}
          data-testid="broadcast"
        />
        {t.broadcast.on}
      </label>
    </p>
    <p class="dim" data-testid="broadcast-state">
      {broadcasting ? t.broadcast.why : t.broadcast.off}
    </p>
  </section>

  {#if broadcasting}
    <section class="card" id="interval">
      <h2>{t.interval.legend}</h2>
      <fieldset data-testid="interval">
        <legend class="sr-only">{t.interval.legend}</legend>
        {#each [0, 1, 2, 5] as min (min)}
          <label>
            <input
              type="radio"
              name="every"
              checked={everyMin === min}
              onchange={() => chooseInterval(min)}
            />
            {min === 0 ? t.interval.off : t.interval.minutes(min)}
          </label>
        {/each}
      </fieldset>
      {#if cost}
        <p class="dim mono" data-testid="cost">
          {t.interval.cost(cost.people, cost.perHour, cost.share)}
        </p>
        {#if crowded}<p class="warn" data-testid="crowded">{t.interval.crowded}</p>{/if}
      {/if}
      <p class="dim">{t.interval.note}</p>
      {#if everyMin === 0}
        <button
          class="primary"
          data-testid="say-now"
          onclick={sayWhereIAm}
          disabled={phase !== "ready" || !here}
        >
          {t.send}
        </button>
      {/if}
    </section>
  {/if}

  <section class="card" id="show">
    <h2>{t.show.legend}</h2>
    <fieldset class="switches" data-testid="switches">
      <legend class="sr-only">{t.show.legend}</legend>
      {#each ["map", "trails", "people", "compass", "checkIn", "hunt"] as key (key)}
        <label>
          <input
            type="checkbox"
            checked={show[key]}
            data-testid={`show-${key}`}
            onchange={(e) => {
              show = { ...show, [key]: e.currentTarget.checked };
              saveShown();
            }}
          />
          {t.show[key]}
        </label>
      {/each}
    </fieldset>
    <p class="dim">{t.show.why}</p>
  </section>

  {#if show.checkIn}
    <section class="card" id="check-in">
      <h2>{t.checkIn.legend}</h2>
      <p class="states" data-testid="check-in">
        {#each STATES as state (state)}
          <button
            class={myState === state ? "primary" : "quiet"}
            data-state={state}
            aria-pressed={myState === state}
            onclick={() => checkIn(state)}
          >
            {t.checkIn.states[state]}
          </button>
        {/each}
      </p>
      <p class="dim" data-testid="my-state">{t.checkIn.mine(t.checkIn.states[myState])}</p>
      <p class="dim">{t.checkIn.why}</p>
    </section>
  {/if}

  {#if show.hunt}
    <section class="card" id="hunt">
      <h2>{t.hunt.legend}</h2>
      <p>
        <label>
          <input type="checkbox" checked={amFox} onchange={toggleFox} data-testid="i-am-fox" />
          {t.hunt.iAmFox}
        </label>
      </p>
      <p class="dim" data-testid="fox">
        {#if peerRows.find((p) => p.role === "fox")}
          {t.hunt.foxHeard(
            peerRows.find((p) => p.role === "fox").name ||
              peerRows.find((p) => p.role === "fox").id,
          )}
        {:else}
          {t.hunt.noFox}
        {/if}
      </p>
      <p class="dim">{t.hunt.why}</p>
      <p class="dim">{t.hunt.slower}</p>
    </section>
  {/if}

  {#if show.compass}
    <section class="card" id="compass">
      <h2>{t.compass.legend}</h2>
      {#if compass}
        <p class="compass" data-testid="compass">
          <span class="needle" style={`transform:rotate(${compass.degrees}deg)`} aria-hidden="true"
            >↑</span
          >
          <span class="mono"
            >{t.compass.line(
              compass.name,
              compassPoint(compass.degrees),
              formatDistance(compass.metres),
            )}</span
          >
        </p>
        <p class="dim" data-testid="compass-age">
          {t.compass.age(ageText(compass.at))}
          {#if nowTick - compass.at > 5 * 60_000}<strong> {t.compass.stale}</strong>{/if}
        </p>
      {:else if !here}
        <p class="dim" data-testid="compass-none">{t.compass.noPlace}</p>
      {:else}
        <p class="dim" data-testid="compass-none">{t.compass.none}</p>
      {/if}
    </section>
  {/if}

  <section class="card" id="where">
    <h2>{t.where.legend}</h2>
    <p data-testid="here">
      {#if here}
        <span class="mono">{formatPosition(here)}</span>
        <span class="dim"> · {here.source === "node" ? t.where.node : t.where.browser}</span>
        {#if here.accuracy != null}
          <span class="dim"> · {t.where.accuracy(Math.round(here.accuracy))}</span>
        {/if}
        {#if here.at}<span class="dim"> · {ageText(here.at)}</span>{/if}
        <!-- The compass has said "stale" past five minutes since it was
             built; this readout only counted upwards, and a number climbing
             past 160 reads as a clock rather than as a problem. -->
        {#if nowTick - here.at > staleAfterMs}
          <strong data-testid="here-stale"> {t.where.stale}</strong>
        {/if}
      {:else}
        <span class="dim">{t.where.none} — {t.where.waiting}</span>
      {/if}
    </p>
    {#if heldBack != null}
      <p class="warn" data-testid="held-back">{t.where.held(heldBack)}</p>
    {/if}
    {#if fixTrouble && here?.source !== "node"}
      <p class="dim" data-testid="fix-trouble">{t.where.trouble[fixTrouble]}</p>
      {#if fixTrouble !== "unsupported"}
        <button class="quiet" data-testid="ask-position" onclick={askAgain}>{t.where.ask}</button>
      {/if}
    {/if}
  </section>

  {#if show.map}
    <section class="card" id="map">
    <h2>{t.map.legend}</h2>
    {#if trails.length === 0 && !here}
      <p class="dim" data-testid="map-empty">{t.map.empty}</p>
    {:else}
      <TrailMap {trails} {here} words={t.map} />
      <p class="dim">{t.map.note}</p>
    {/if}
    </section>
  {/if}

  {#if show.people}
    <section class="card" id="people">
    <h2>{t.people.legend}</h2>
    <p class="dim mono" data-testid="people-summary">{t.people.summary(peerSummary)}</p>
    {#if peerRows.length === 0}
      <p class="dim" data-testid="people-empty">{t.people.empty}</p>
    {:else}
      <ul class="people" data-testid="people">
        {#each peerRows as peer (peer.id)}
          <li data-peer={peer.id}>
            <span class="swatch" style={`background:${colourOf(peer.id) ?? "transparent"}`}></span>
            <span class="who">
              <input
                class="name"
                value={peer.name}
                placeholder={t.people.namePlaceholder}
                aria-label={t.people.namePlaceholder}
                oninput={(e) => renamePeer(peer.id, e.currentTarget.value)}
              />
              <small class="dim mono">{peer.id}</small>
            </span>
            <span class="facts dim mono">
              {#if peer.role === "fox"}<strong class="badge">🦊</strong>{/if}
              {#if peer.state !== "ok"}<strong class="badge">{t.checkIn.states[peer.state]}</strong>{/if}
              {t.people.lastHeard(ageText(peer.lastAt))}
              {#if distanceOf(peer) != null}
                · {formatDistance(distanceOf(peer))}
              {/if}
              {#if headingOf(peer) != null}
                · {compassPoint(headingOf(peer))}
              {/if}
            </span>
            <label class="draw">
              <input
                type="checkbox"
                checked={peer.shown}
                onchange={(e) => togglePeer(peer.id, e.currentTarget.checked)}
              />
              {t.people.show}
            </label>
            {#if show.compass}
              <button
                class="quiet"
                data-testid={`follow-${peer.id}`}
                onclick={() => (following = following === peer.id ? "" : peer.id)}
              >
                {following === peer.id ? t.compass.stop : t.compass.follow}
              </button>
            {/if}
            <button class="quiet" onclick={() => forgetPeer(peer.id)}>{t.people.forget}</button>
          </li>
        {/each}
      </ul>
      <p class="dim">{t.people.nameWhy}</p>
    {/if}
    </section>
  {/if}

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
    <p class="dim">{@html creditHTML()}</p>
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

  /* Who is out there. One row per device, and the swatch is the only thing
     tying a name in this list to a trail on the map — so it is the first
     thing in the row and the same colour the map drew. */
  /* Written at last. A <fieldset> wants a <legend> so the group has a name a
     screen reader can say, and both of these cards already show that name as
     their <h2> — so the legend was marked `sr-only` and the class was never
     defined, which printed it a second time under the heading. */
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    margin: -1px;
    padding: 0;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
    border: 0;
  }

  .switches,
  .states {
    display: flex;
    /* Spelled out, because `fieldset` above sets `column` and this rule did
       not say otherwise. A wrapping row that is secretly a column puts every
       label on its own line and `align-items: center` then centres each one
       on its own width — which is why the switch list came out as a staircase
       on a phone, every line starting at a different indent. */
    flex-direction: row;
    flex-wrap: wrap;
    gap: 0.5rem 1rem;
    border: 0;
    padding: 0;
    margin: 0.4rem 0 0.3rem;
    align-items: center;
  }

  .states button {
    flex: 1 1 auto;
  }

  .compass {
    display: flex;
    align-items: center;
    gap: 0.7rem;
    font-size: 1.05rem;
  }

  /* An arrow that points, rather than a word that has to be converted into
     one while walking. The compass point stays beside it for anybody holding
     a real compass, or reading this aloud. */
  .needle {
    display: inline-block;
    font-size: 2rem;
    line-height: 1;
    transition: transform 0.4s ease;
  }

  .badge {
    display: inline-block;
    padding: 0 0.3rem;
    border-radius: 0.25rem;
    background: color-mix(in srgb, currentColor 12%, transparent);
    margin-right: 0.3rem;
  }

  .people {
    list-style: none;
    margin: 0.6rem 0 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .people li {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    flex-wrap: wrap;
  }

  .swatch {
    width: 0.9rem;
    height: 0.9rem;
    border-radius: 0.25rem;
    flex: none;
    /* A device switched off has no colour on the map, and an empty square
       here says so rather than leaving a gap the eye reads as a bug. */
    box-shadow: inset 0 0 0 1px color-mix(in srgb, currentColor 30%, transparent);
  }

  .who {
    display: flex;
    flex-direction: column;
    gap: 0.1rem;
    min-width: 11rem;
  }

  .name {
    font: inherit;
    padding: 0.25rem 0.4rem;
    border-radius: 0.3rem;
    border: 1px solid color-mix(in srgb, currentColor 25%, transparent);
    background: transparent;
    color: inherit;
    width: 11rem;
  }

  .facts {
    flex: 1 1 12rem;
  }

  .draw {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    white-space: nowrap;
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
