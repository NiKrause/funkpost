<!-- SPDX-License-Identifier: GPL-3.0-only -->
<script>
  /**
   * mesh-todo: two phones, two nodes, and a radio between them — and the demo
   * is also the bench instrument. The sync pane shows every protocol message
   * with its cost, because the two hardware gates in issue #1 are read off
   * exactly these numbers.
   *
   * There is an IP path too (P10, `?ip=1`, on by default with a real radio),
   * and it exists to be lost: what the phase is about is the afternoon the
   * internet goes and the list carries on over the air.
   */
  import { onMount } from "svelte";
  import { creditHTML, lang } from "@le-space/funkpost-brand";
  import { WORDS } from "./words.js";
  import {
    createDatabaseStack,
    joinOverInternet,
    carryOverInternet,
    carryOverMesh,
    internetPeers,
    watchInternet,
    relayMultiaddrs,
    relaySource,
    connectCourier,
    createList,
    joinList,
    attachCourier,
    startHeartbeat,
    sendInvite,
    watchInvites,
    backUpAndPoint,
    restoreFromPointer,
    watchFoundingPointers,
    probeMeshtasticCore,
  } from "./stack.js";
  import {
    describeMeshtasticError,
    preferredChannelIndex,
    DEFAULT_PREFERRED_CHANNEL,
  } from "@le-space/funkpost";

  const build = __BUILD_INFO__;
  // The page's words in its current language; a log line keeps the language it
  // was written in.
  const t = $derived(WORDS[$lang]);
  const w = () => WORDS[lang.get()];
  $effect(() => {
    document.title = t.title;
  });
  const params = new URLSearchParams(location.search);
  // P10: the internet path. On by default with a real radio — that is the case
  // #82 asks about, internet first and the mesh when it goes — and off with the
  // fake mesh, so the e2e suite stays a closed room. ?ip=1 / ?ip=0 override.
  const wantsInternet =
    params.get("ip") === "1" || (params.get("ip") !== "0" && params.get("mesh") !== "bc");
  const mode =
    params.get("mesh") === "bc"
      ? {
          kind: "bc",
          room: params.get("room") ?? "mesh-todo",
          loss: Number(params.get("loss") ?? 0),
          preset: params.get("preset") ?? undefined,
        }
      : { kind: "ble" };
  // How long a minute is, for the heartbeat. Only the e2e suite changes it:
  // ?minute=300 makes a round of five beats last a second and a half, and the
  // hour between two rounds eighteen seconds.
  const minuteMs = Math.max(100, Number(params.get("minute")) || 60_000);
  // A list's link: the page's own address names the list, so a link or the
  // page's QR code opens it on another device. Nothing else is read from the
  // hash.
  const linked = (() => {
    const named = new URLSearchParams(location.hash.slice(1)).get("list");
    return named?.startsWith("/orbitdb/") ? named : null;
  })();

  let phase = $state("boot"); // boot → idle → connecting → ready
  let linkKind = $state("");
  let region = $state("");
  let budget = $state(null);
  let airUtil = $state(null);
  let error = $state("");

  let stack = null;
  let courier = null;
  let connection = null; // the live link handle, for figures the courier does not carry
  let sync = null;
  let db = $state(null);
  let address = $state("");
  let invite = $state("");
  let todos = $state([]);
  let newText = $state("");
  let probeResult = $state("");
  let linkLost = $state(false);
  let reconnecting = $state(false);
  let creating = $state(false);
  let joining = $state(false);
  let openingLink = $state(false);
  let inviteFrom = $state("mesh"); // or "link": who named the list waiting to be joined
  // The heartbeat: does another device keeping this list answer on the air?
  let heartbeat = null;
  let heartbeatStarting = false;
  let beat = $state(null);
  let wiring = null; // an attach in progress, so a second caller can wait for it
  const nodeReady = $derived(phase === "ready");
  // P9: the founding, off the radio. A pointer names a backup; the bytes come
  // over HTTPS when there is internet, and the radio carried one frame.
  let pointer = $state(null);
  // Which path carries the log right now, and what the internet one is doing.
  let carriedBy = $state(wantsInternet ? "internet" : "mesh");
  let ipPeers = $state([]);
  // What the internet path is doing, shown before any list exists: the page is
  // a libp2p node from the moment it loads.
  let selfId = $state("");
  let relayIds = $state([]);
  let conns = $state([]);
  /** How a connection reaches the other side, in the words a reader wants. */
  const kindOf = (c) =>
    t.connKinds[
      relayIds.includes(c.peer)
        ? "relay"
        : c.addr.includes("/webrtc")
          ? "direct"
          : c.addr.includes("/p2p-circuit")
            ? "relayed"
            : "other"
    ];
  const otherPeers = $derived([...new Set(conns.filter((c) => !relayIds.includes(c.peer)).map((c) => c.peer))]);
  const relaysConnected = $derived(relayIds.filter((id) => conns.some((c) => c.peer === id)).length);
  let switching = $state(false);
  // P10 step 3/4: the internet going is a question the page asks the network,
  // and an offer it makes the reader — never a switch it throws by itself.
  let internetReachable = $state(true);
  let offerTheMesh = $state(false);
  // P10 step 5: who is out there, as opposed to which radios are. The node
  // below lists the radios it has heard; that is a different question, and
  // answering it with this one is how an app ends up talking to nobody.
  let company = $state({ peers: [], lastHeardAgoMs: null });
  let asking = $state(false);
  let askedAt = $state(null);
  let backingUp = $state(false);
  let restoring = $state(false);
  let online = $state(navigator.onLine);
  let neighbours = $state([]);
  let primaryChannel = $state(null); // { name, fingerprint }
  let channels = $state([]); // [{ index, name, fingerprint, role }]
  let txChannel = $state(0);
  let myNode = $state("");
  let setTxChannelFn = () => {};
  const channelMap = new Map();

  // Which channel to pick on its own, if the node has it. Index 0 is a poor
  // default for meeting somebody: the index is per-device, so the same channel
  // can be 1 here and 3 there. `?channel=` overrides it for a private bench,
  // and an empty value switches the whole thing off.
  const preferredChannel = params.has("channel")
    ? params.get("channel")
    : DEFAULT_PREFERRED_CHANNEL;
  let txChannelChosenByHand = false;
  let preferenceApplied = false;

  /**
   * Only ever moves off a channel nobody chose. Called once the connection is
   * up and again whenever a channel arrives — the node reports them one at a
   * time, and the one we want may not be first.
   */
  function applyPreferredChannel() {
    if (preferenceApplied || txChannelChosenByHand) return;
    const index = preferredChannelIndex(channels, preferredChannel);
    if (index == null) return;
    preferenceApplied = true;
    txChannel = index;
    setTxChannelFn(index);
    restartHeartbeat();
    const ch = channels.find((c) => c.index === index);
    pushLog(w().log.autoChannel(index, ch?.name, ch?.fingerprint));
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
    if (entry.role === 1) {
      primaryChannel = { name: entry.name, fingerprint: entry.fingerprint };
    }
    pushLog(w().log.nodeChannel(entry.index, entry.name, entry.fingerprint, entry.role === 1));
    // Channels arrive one at a time and the wanted one need not be first.
    // Before the connection resolves this is a no-op, so the call after it is
    // the one that lands in the common case.
    applyPreferredChannel();
  }

  // Screen Wake Lock: phones auto-lock, and Web Bluetooth pauses with the
  // screen — the bench's quiet killer. Desktop screens do not take the radio
  // down with them, so the checkbox only exists on handheld devices.
  //
  // Detection deliberately does NOT gate on `userAgentData.mobile` alone: an
  // unfolded Samsung Fold (and Android tablets) report `mobile === false`
  // while still being battery devices that sleep the screen under us. And
  // `mobile ?? regex` was a bug — `??` only falls back on null/undefined, so a
  // `false` from a foldable skipped the UA check entirely and hid the box.
  const isMobileDevice =
    navigator.userAgentData?.mobile === true ||
    /Android|iPhone|iPad|iPod|Mobi/i.test(navigator.userAgent);
  const wakeLockSupported = "wakeLock" in navigator;
  let keepAwake = $state(false);
  let wakeSentinel = null;

  async function acquireWakeLock() {
    try {
      wakeSentinel = await navigator.wakeLock.request("screen");
      wakeSentinel.addEventListener("release", () => {
        wakeSentinel = null;
        if (keepAwake) pushLog(w().log.wakeReleased);
      });
      pushLog(w().log.wakeOn);
    } catch (e) {
      keepAwake = false;
      pushLog(w().log.wakeRefused(e.message));
    }
  }

  async function toggleAwake() {
    if (keepAwake) {
      await acquireWakeLock();
    } else {
      await wakeSentinel?.release();
      wakeSentinel = null;
      pushLog(w().log.wakeOff);
    }
  }

  const reacquireOnReturn = () => {
    if (keepAwake && document.visibilityState === "visible" && !wakeSentinel) acquireWakeLock();
  };
  let showNeighbours = $state(false);
  let nowTick = $state(Date.now());
  const neighbourMap = new Map();
  let log = $state([]);
  let logSeq = 0; // monotonic, unique — the {#each} key
  let totals = $state({ framesTx: 0, framesRx: 0, airtimeSpentMs: 0, retransmitRounds: 0 });
  // Frames the radio stopped retransmitting — see funkpost issue #73.
  let refusals = $state({ soft: 0, last: null });

  const stamp = () =>
    new Date().toLocaleTimeString(undefined, { hour12: false }) +
    "." +
    String(Date.now() % 1000).padStart(3, "0");

  // The key MUST be unique: two identical lines in the same millisecond (a
  // burst of the same error) previously collided on ts+text, which threw
  // Svelte's each_key_duplicate — caught by window.onerror, which logged
  // another identical line, which collided again: a self-amplifying storm.
  // A monotonic id ends it.
  const pushLog = (text) => {
    log.unshift({ id: logSeq++, ts: stamp(), text });
    if (log.length > 120) log.pop();
  };

  // Turn anything — Error, a rejection object, the Meshtastic queue's
  // {id, error} shape — into a readable line. A bare `${obj}` prints the
  // useless "[object Object]" that hid the real cause on the bench. The
  // routing-code table used to be hand-copied here; it now comes from the
  // firmware enum via the library (issue #37).
  const describeError = describeMeshtasticError;

  const onCourierEvent = (event) => {
    if (event.kind === "payload-rx") pushLog(w().log.payloadRx(event.bytes, event.msgId));
    if (event.kind === "delivered") pushLog(w().log.delivered(event.msgId, event.rounds));
    if (event.kind === "giveup") pushLog(w().log.giveup(event.msgId, event.rounds, event.reason));
    if (event.kind === "error") pushLog(`! ${describeError(event.error)}`);
  };

  const wireSyncLog = (s) => {
    s.on("message", ({ direction, type, bytes }) =>
      pushLog(`${direction === "out" ? "→" : "←"} ${type} ${bytes} B`),
    );
    s.on("synced", ({ joined }) => pushLog(w().log.synced(joined)));
    s.on("error", (e) => pushLog(w().log.syncError(e.message)));
  };

  const refreshTodos = async () => {
    if (!db) return;
    const all = await db.all();
    todos = all
      .map(({ key, value }) => ({ key, ...value }))
      .sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
  };

  const attachDb = (opened) => {
    if (db) return;
    db = opened;
    address = opened.address;
    invite = "";
    opened.events.on("update", refreshTodos);
    refreshTodos();
    pushLog(w().log.dbOpen(opened.address.slice(0, 24)));
    // The address bar now names the list: the link to share, and what the
    // page's QR code shows.
    history.replaceState(null, "", `${location.pathname}${location.search}#list=${opened.address}`);
    wireList();
  };

  /**
   * What the list and the node need from each other once both are here, in
   * whichever order they came. A list made before the node gets its mesh path
   * now; the heartbeat starts either way.
   *
   * @returns {Promise<void>} settles when the mesh path is attached
   */
  function wireList() {
    if (!db || !courier) return Promise.resolve();
    if (!sync && !wiring) {
      wiring = attachCourier({ db, courier, start: carriedBy === "mesh" })
        .then((attached) => {
          sync = attached;
          wireSyncLog(sync);
          pushLog(carriedBy === "mesh" ? w().log.attachedMesh : w().log.attachedQuiet);
        })
        .catch((e) => pushLog(w().log.attachFailed(e.message)))
        .finally(() => (wiring = null));
    }
    maybeStartHeartbeat();
    return wiring ?? Promise.resolve();
  }

  async function maybeStartHeartbeat() {
    if (heartbeat || heartbeatStarting || !courier || !db) return;
    heartbeatStarting = true;
    try {
      heartbeat = await startHeartbeat({
        courier,
        address: db.address,
        minuteMs,
        onChange: (state) => (beat = state),
        onEvent: logBeat,
      });
    } catch (e) {
      pushLog(w().log.heartbeatError(e.message));
    } finally {
      heartbeatStarting = false;
    }
  }

  /** Another channel is another audience: what answered on the old one says nothing. */
  function restartHeartbeat() {
    if (!heartbeat) return;
    heartbeat.stop();
    heartbeat = null;
    beat = null;
    maybeStartHeartbeat();
  }

  const clockText = (at) =>
    at == null
      ? "—"
      : new Date(at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });
  const agoText = (ms) =>
    ms == null ? "" : ms < 60_000 ? t.led.justNow : t.led.minAgo(Math.round(ms / 60_000));

  const logBeat = (event) => {
    if (event.kind === "beat") {
      pushLog(w().log.beat(event.beat, event.of));
    }
    if (event.kind === "heard") pushLog(w().log.heard(event.type, event.from));
    if (event.kind === "echo") pushLog(w().log.echo(event.to));
    if (event.kind === "round" && !event.answered) {
      pushLog(w().log.alone(clockText(event.nextRoundAt)));
    }
    if (event.kind === "error") pushLog(w().log.heartbeatError(describeError(event.error)));
  };

  // The LED: steady only with a node connected and another device keeping this
  // list answering its heartbeat. Everything short of that blinks, and says why.
  const led = $derived.by(() => {
    const words = t.led;
    if (linkLost) return { steady: false, text: words.lost };
    if (reconnecting) return { steady: false, text: words.reconnecting };
    if (!nodeReady) {
      return { steady: false, text: phase === "connecting" ? words.connecting : words.none };
    }
    if (!db) return { steady: false, text: words.noList };
    if (!beat) return { steady: false, text: words.starting };
    if (beat.lastError) return { steady: false, text: words.cannot(beat.lastError) };
    const checking = beat.beat > 0 ? words.checking(beat.beat, beat.beatsPerRound) : "";
    if (beat.verdict === "answered") {
      const others = Math.max(1, beat.peers.length);
      return {
        steady: true,
        text: words.answered(others, agoText(beat.lastHeardAgoMs)) + checking,
      };
    }
    if (beat.verdict === "alone") {
      return {
        steady: false,
        text: words.alone + (checking || words.nextAt(clockText(beat.nextRoundAt))),
      };
    }
    return { steady: false, text: words.looking(beat.beat, beat.beatsPerRound) };
  });

  onMount(async () => {
    // On a phone the console is invisible; surface anything that would
    // otherwise tear the connection down silently — an exception in a
    // config handler, a rejecting promise, a polyfill edge case.
    const onWinError = (e) =>
      pushLog(w().log.windowError(e.type, describeError(e.reason ?? e.error ?? e.message ?? e)));
    window.addEventListener("error", onWinError);
    window.addEventListener("unhandledrejection", onWinError);
    // The pointer path is the only thing here that wants the internet, so the
    // buttons say plainly when there is none.
    const onOnline = () => (online = navigator.onLine);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOnline);

    if (params.get("probe") === "meshtastic-core") {
      try {
        probeResult = await probeMeshtasticCore();
      } catch (e) {
        probeResult = `CRASH: ${e.message}`;
      }
    }
    stack = await createDatabaseStack({ internet: wantsInternet });
    if (wantsInternet) {
      pushLog(w().log.internetUp(relaySource));
      selfId = stack.libp2p.peerId.toString();
      relayMultiaddrs().then((addresses) => {
        relayIds = [...new Set(addresses.map((a) => a.match(/\/p2p\/([^/]+)$/)?.[1]).filter(Boolean))];
        pushLog(w().log.relaysKnown(relayIds.length));
      });
      const look = () => {
        ipPeers = internetPeers(stack.libp2p);
        conns = stack.libp2p
          .getConnections()
          .filter((connection) => connection.status === "open")
          .map((connection) => ({
            peer: connection.remotePeer.toString(),
            addr: connection.remoteAddr.toString(),
          }));
      };
      look();
      setInterval(look, 2000);
      // Connections and a probe, not navigator.onLine: it reports the
      // interface, not reachability, so a captive portal is "online" and
      // reaches nobody.
      watchInternet({
        libp2p: stack.libp2p,
        relays: relayMultiaddrs,
        onChange: ({ reachable, peers }) => {
          internetReachable = reachable;
          ipPeers = reachable ? ipPeers : [];
          pushLog(reachable ? w().log.internetBack(peers) : w().log.internetGone);
          // The offer, not the switch: the radio spends a rationed budget, and
          // pairing a node needs a gesture anyway.
          if (!reachable && carriedBy === "internet" && db) offerTheMesh = true;
        },
      });
    }
    phase = "idle";
    // `autoconnect=0` leaves the fake node unpaired until the button is
    // pressed, as a real one is — for the path where the list comes first.
    if (mode.kind === "bc" && params.get("autoconnect") !== "0") connect();
    if (linked) {
      // Over the internet a link is enough to open the list. Without an
      // internet path only the radio can bring it, so it waits as an invite.
      if (wantsInternet) openLinked(linked);
      else {
        invite = linked;
        inviteFrom = "link";
      }
    }
    const ticker = setInterval(() => {
      if (courier) {
        budget = courier.budget();
        totals = { ...courier.stats };
        if (connection?.refusals) refusals = { ...connection.refusals };
        // One frame is what a single todo costs.
        if (courier.timeUntilAffordable) blockedForMs = courier.timeUntilAffordable();
      }
      if (sync && !db && sync.db) attachDb(sync.db);
      // Only while the courier is started: on the internet path it is stopped,
      // and a stopped sync hears no answers — reporting its last ones as if
      // they were current would be the same lie as counting radios.
      if (sync && carriedBy === "mesh") company = sync.presence();
      if (heartbeat) beat = heartbeat.state();
      nowTick = Date.now();
    }, 1000);
    document.addEventListener("visibilitychange", reacquireOnReturn);
    return () => {
      clearInterval(ticker);
      heartbeat?.stop();
      document.removeEventListener("visibilitychange", reacquireOnReturn);
    };
  });

  async function connect() {
    error = "";
    phase = "connecting";
    try {
      const connected = await connectCourier({
        mode,
        onEvent: onCourierEvent,
        onTelemetry: (value) => (airUtil = value),
        onRegion: (name) => {
          region = name;
          pushLog(w().log.region(name));
        },
        onChannel: handleChannel,
        onMyNodeInfo: (info) => {
          if (info?.myNodeNum) myNode = `!${info.myNodeNum.toString(16).padStart(8, "0")}`;
        },
        onNodeInfo: (node) => {
          neighbourMap.set(node.num, node);
          neighbours = [...neighbourMap.values()].sort(
            (a, b) => (b.lastHeard ?? 0) - (a.lastHeard ?? 0),
          );
        },
        onError: (msg) => pushLog(`! ${msg}`),
        onStatus: (name) => pushLog(w().log.nodeStatus(name)),
        onReconnecting: (n) => {
          reconnecting = true;
          pushLog(w().log.linkDropped(n));
        },
        onReconnected: () => {
          reconnecting = false;
          pushLog(w().log.reconnected);
          // Re-announce so the peer re-diffs heads and the courier's ARQ
          // re-sends whatever the drop interrupted (e.g. the bootstrap blocks).
          sync?.announce?.();
        },
        onGaveUp: () => {
          reconnecting = false;
          linkLost = true;
          error = w().errors.gaveUp;
          pushLog(w().log.gaveUp);
        },
      });
      courier = connected.courier;
      connection = connected;
      linkKind = connected.kind;
      region = connected.region;
      setTxChannelFn = connected.setTxChannel ?? (() => {});
      // Deliberate test seam: the e2e suite has no radio to report channels,
      // and channel selection is a path that fails *silently* when it is wrong
      // — so it is worth exercising rather than reasoning about.
      window.__nodeChannel = handleChannel;
      // Now that the switch actually does something, act on whatever the node
      // already told us while it was still connecting.
      applyPreferredChannel();
      budget = courier.budget();
      watchInvites(courier, (addr) => {
        if (db) return;
        invite = addr;
        inviteFrom = "mesh";
      });
      watchFoundingPointers(courier, (p) => {
        if (!db) pointer = p;
        pushLog(w().log.pointerHeard(p.address.slice(0, 20), p.cid.slice(0, 12)));
      });
      phase = "ready";
      pushLog(w().log.linkUp(w().linkKinds[linkKind] ?? linkKind, region));
      wireList();
    } catch (e) {
      error = e.message;
      phase = "idle";
    }
  }

  async function create() {
    error = "";
    creating = true;
    pushLog(courier ? w().log.creatingOnAir : w().log.creatingNoNode);
    try {
      const made = await createList({ orbitdb: stack.orbitdb, courier });
      sync = made.sync;
      if (sync) wireSyncLog(sync);
      attachDb(made.db);
      if (made.sync) pushLog(w().log.inviteSent);
      if (carriedBy === "internet") {
        await carryOverInternet({ db: made.db, sync });
        pushLog(w().log.carriedInternetCreate(Boolean(sync)));
      }
    } catch (e) {
      error = e.message;
      pushLog(w().log.createFailed(e.message));
    } finally {
      creating = false;
    }
  }

  async function join() {
    error = "";
    if (carriedBy === "mesh" && !courier) {
      error = w().errors.joinNeedsNode;
      return;
    }
    joining = true;
    pushLog(w().log.joiningOnAir);
    try {
      if (carriedBy === "internet") {
        const joined = await joinOverInternet({
          orbitdb: stack.orbitdb,
          courier,
          address: invite,
        });
        sync = joined.sync;
        wireSyncLog(sync);
        attachDb(joined.db);
        pushLog(w().log.joinedInternet);
      } else {
        const joined = await joinList({ orbitdb: stack.orbitdb, courier, address: invite });
        sync = joined.sync;
        wireSyncLog(sync);
        pushLog(w().log.joiningDelta);
      }
    } catch (e) {
      error = e.message;
      pushLog(w().log.joinFailed(e.message));
    } finally {
      joining = false;
    }
  }

  /** Open the list a link names: over the internet, with or without a node. */
  async function openLinked(named) {
    error = "";
    openingLink = true;
    pushLog(w().log.openingLink);
    try {
      const joined = await joinOverInternet({ orbitdb: stack.orbitdb, courier, address: named });
      if (joined.sync) {
        sync = joined.sync;
        wireSyncLog(sync);
      }
      attachDb(joined.db);
      pushLog(w().log.listOpen(!courier));
    } catch (e) {
      error = e.message;
      pushLog(w().log.openFailed(e.message));
    } finally {
      openingLink = false;
    }
  }

  /**
   * Move the log from one path to the other. One at a time, always: both on the
   * same log stalled every run in test/fallback-one-log.test.js.
   */
  async function carryOver(path) {
    if (!db || switching || path === carriedBy) return;
    if (path === "mesh" && !sync) return; // no node yet — connectAndCarry pairs one first
    switching = true;
    try {
      if (path === "internet") {
        await carryOverInternet({ db, sync });
        pushLog(w().log.carriedInternet);
      } else {
        await carryOverMesh({ db, sync });
        pushLog(w().log.carriedMesh);
      }
      carriedBy = path;
      if (path === "mesh") {
        offerTheMesh = false;
        company = { peers: [], lastHeardAgoMs: null }; // the other path's silence says nothing
        askWhoIsThere(); // the next thing anyone wants to know, so do not make them ask
      }
    } catch (e) {
      error = e.message;
      pushLog(w().log.switchFailed(e.message));
    } finally {
      switching = false;
    }
  }

  /**
   * The mesh, on a page that has no node yet: pair one, then move the list
   * onto it. connect() goes first, while the click still counts as the
   * gesture the Bluetooth chooser needs.
   */
  async function connectAndCarry() {
    await connect();
    if (phase !== "ready") return;
    await wireList();
    await carryOver("mesh");
  }

  /**
   * Ask whether another app is out there — the question the node cannot
   * answer.
   *
   * A radio reports the radios in range, and on a public channel most of them
   * are somebody's router. Only a program keeping this same list can say it is
   * keeping it, so this asks on the air and waits for an answer: two small
   * messages, against a delta that costs frames.
   */
  async function askWhoIsThere() {
    if (!sync || asking || carriedBy !== "mesh") return;
    asking = true;
    askedAt = Date.now();
    pushLog(w().log.askingAir);
    try {
      await sync.hello();
      // An answer has to travel, and this carrier is slow on purpose.
      await new Promise((resolve) => setTimeout(resolve, 6000));
      company = sync.presence();
      pushLog(
        company.peers.length > 0
          ? w().log.appsAnswered(company.peers.length, company.peers.map((peer) => peer.id).join(", "))
          : w().log.nobodyAnswered,
      );
    } catch (e) {
      pushLog(w().log.askFailed(e.message));
    } finally {
      asking = false;
    }
  }

  /** Back the list up over the internet, and name it over the radio. */
  async function backUp() {
    error = "";
    backingUp = true;
    pushLog(w().log.backingUp);
    try {
      const { cid, blocks } = await backUpAndPoint({ orbitdb: stack.orbitdb, db, courier });
      pushLog(w().log.pointerSent(blocks, cid.slice(0, 12)));
    } catch (e) {
      error = e.message;
      pushLog(w().log.backupFailed(e.message));
    } finally {
      backingUp = false;
    }
  }

  /** Take the list from the pointer: bytes over HTTPS, nothing over the air. */
  async function restorePointed() {
    error = "";
    restoring = true;
    pushLog(w().log.restoring);
    try {
      const restored = await restoreFromPointer({ orbitdb: stack.orbitdb, courier, pointer });
      sync = restored.sync;
      wireSyncLog(sync);
      attachDb(restored.db);
      pointer = null;
      pushLog(w().log.restored(restored.entries, restored.blocks));
    } catch (e) {
      error = e.message;
      pushLog(w().log.restoreFailed(e.message));
    } finally {
      restoring = false;
    }
  }

  // Writes land locally and wait. The radio is not a side effect of typing:
  // each announce draws a want and a block reply, so five todos sent one by one
  // are five round trips where a single delta would carry all five — createDelta
  // walks from the heads down to the peer's.
  let unsent = $state(0);
  let sending = $state(false);

  async function add() {
    const text = newText.trim();
    if (!text || !db) return;
    newText = "";
    await db.put(`t${Date.now()}`, { text, done: false, ts: Date.now() });
    unsent++;
  }

  async function toggle(todo) {
    await db.put(todo.key, { text: todo.text, done: !todo.done, ts: todo.ts });
    unsent++;
  }

  /** The one place this app spends airtime on purpose. */
  async function sendChanges() {
    if (!sync || sending) return;
    sending = true;
    const carried = unsent;
    try {
      await sync.announce();
      // Cleared on the announce, not on a delivery: the ARQ decides whether it
      // lands, and claiming otherwise here would be a lie the courier can see
      // through. What was written is now the peer's business to ask for.
      unsent = 0;
      pushLog(w().log.announced(carried));
    } catch (e) {
      pushLog(w().log.sendFailed(describeError(e)));
    } finally {
      sending = false;
    }
  }

  const heardAgo = (node) => {
    if (!node.lastHeard) return "—";
    const seconds = Math.max(0, Math.round(nowTick / 1000 - node.lastHeard));
    if (seconds < 90) return t.ago.s(seconds);
    if (seconds < 5400) return t.ago.m(Math.round(seconds / 60));
    return t.ago.h(Math.round(seconds / 3600));
  };

  // Airtime is rationed by law and the node enforces it: past the limit it
  // simply refuses to transmit. A progress bar shading towards empty does not
  // tell anyone that adding a todo has stopped working, so say it and stop
  // offering the actions that cannot happen.
  let blockedForMs = $state(0);
  const airtimeBlocked = $derived(blockedForMs > 0);
  const untilFree = $derived.by(() => {
    if (blockedForMs <= 0) return "";
    const minutes = Math.ceil(blockedForMs / 60_000);
    return minutes <= 1 ? t.underAMinute : t.inMinutes(minutes);
  });
  const dutyCycleText = $derived(
    budget?.dutyCycle == null
      ? ""
      : t.perHour((budget.dutyCycle * 100).toFixed(budget.dutyCycle < 0.05 ? 1 : 0)),
  );

  const budgetPercent = () => {
    if (!budget || budget.dutyCycle == null) return null;
    return Math.round((budget.remainingAirtimeMs / (budget.dutyCycle * 3_600_000)) * 100);
  };

  // The notice is per browser, not per room: it is about the project, not about
  // any one list. A browser that refuses storage simply shows it every time,
  // which is the safe direction for a warning to fail in.
  const NOTICE_KEY = "funkpost:notice-dismissed:v1";
  const readDismissed = () => {
    try {
      return localStorage.getItem(NOTICE_KEY) === "1";
    } catch {
      return false;
    }
  };
  let showNotice = $state(!readDismissed());
  const dismissNotice = () => {
    showNotice = false;
    try {
      localStorage.setItem(NOTICE_KEY, "1");
    } catch {
      /* dismissed for this visit only */
    }
  };
</script>

<main>
  <h1>mesh-todo</h1>
  <p class="tag">{t.tagline(wantsInternet)}</p>
  <p
    class="led-line"
    data-testid="led"
    data-state={led.steady ? "steady" : "blinking"}
    title={t.led.title}
  >
    <span class="led" class:steady={led.steady} aria-hidden="true"></span>
    <span data-testid="led-label">{led.text}</span>
  </p>

  <!-- Dismissible, and it stays dismissed: somebody using this as a bench
       instrument reads it once and then wants the screen back. -->
  {#if showNotice}
    <aside class="notice" data-testid="experimental-notice">
      {#if $lang === "de"}
        <p>
          <strong>Experimentell.</strong> Eine Forschungsdemo, nicht auditiert,
          nicht für den Produktiveinsatz — und wer den Kanal empfängt, kann in
          diese Liste schreiben.
        </p>
        <p>
          Sie ist auch <strong>die Messung, nicht das Produkt</strong>: Diese
          Anordnung verschickt ganze OrbitDB-Blöcke, und eine Liste mit drei
          Einträgen ist über das Mesh spürbar langsam. Dieses Ergebnis ist der
          Zweck des Experiments. Eine leichtere Form — wenige Bytes pro Ereignis
          statt Blockübertragungen — setzt
          <a href="https://nikrause.github.io/funkpost/mesh-calendar/">mesh-calendar</a>
          bereits um, und dorthin geht die Entwicklung.
        </p>
      {:else}
        <p>
          <strong>Experimental.</strong> A research demo, not audited, not for
          production — and anyone who can hear the channel may write to this list.
        </p>
        <p>
          It is also <strong>the measurement, not the product</strong>: this
          arrangement ships whole OrbitDB blocks, and a three-entry list is
          noticeably slow over the mesh. That result is the point of the
          experiment. A lighter shape — a few bytes per event instead of block
          transfers — is what
          <a href="https://nikrause.github.io/funkpost/mesh-calendar/">mesh-calendar</a>
          already does, and where this is heading.
        </p>
      {/if}
      <button class="dismiss" onclick={dismissNotice} data-testid="dismiss-notice">
        {t.dismiss}
      </button>
    </aside>
  {/if}

  {#if wantsInternet}
    <section data-testid="internet">
      <h2>{t.internet} <span class="dim">{t.normalPath}</span></h2>
      {#if $lang === "de"}
        <p class="dim">
          Diese Seite ist vom Öffnen an ein Peer-to-Peer-Knoten. Sie findet die auf Aleph
          registrierten Relays, trifft andere mesh-todo-Seiten auf einem gemeinsamen
          Discovery-Topic und verbindet sich mit ihnen — direkt über WebRTC, wo es geht, über
          ein Relay, wo nicht. Eine Liste reist über diese Verbindungen; das LoRa-Mesh ist für
          den Fall, dass sie wegfallen. Eine Liste braucht keinen Knoten: unten eine anlegen,
          und ihr Link — oder der QR-Code dieser Seite — öffnet sie auf einem anderen Gerät.
        </p>
      {:else}
        <p class="dim">
          This page is a peer-to-peer node from the moment it opens. It finds the relays
          registered on Aleph, meets other mesh-todo pages on a shared discovery topic, and
          connects to them — directly over WebRTC where it can, through a relay where it
          cannot. A list travels over these connections; the LoRa mesh is for when they are
          gone. A list needs no node: make one below, and its link — or this page's QR code —
          opens it on another device.
        </p>
      {/if}
      <p>
        <strong>{internetReachable ? t.online : t.internetGone}</strong>
        · <span data-testid="relays">{t.relays(relaysConnected, relayIds.length)}</span>
        · <span data-testid="peer-count">{t.otherPages(otherPeers.length)}</span>
      </p>
      {#if conns.length > 0}
        <ul class="conns">
          {#each conns as c (c.peer + c.addr)}
            <li><span class="mono">…{c.peer.slice(-8)}</span> · {kindOf(c)}</li>
          {/each}
        </ul>
      {/if}
      {#if selfId}<p class="dim mono">{t.thisNode} …{selfId.slice(-8)}</p>{/if}
    </section>
  {/if}

  <section>
    <h2>{t.node}</h2>
    {#if phase === "boot"}
      <p>{t.startingStack}</p>
    {:else if phase === "connecting"}
      <p>{t.connecting}</p>
    {:else if phase === "ready"}
      <p>
        <strong>{t.linkKinds[linkKind] ?? linkKind}</strong> — {t.region} <strong>{region}</strong>
        {#if airUtil != null}
          · <span title={t.nodeAirtimeTitle}>{t.nodeAirtime(airUtil.toFixed(1))}</span>
        {/if}
      </p>
      {#if primaryChannel || myNode}
        <p class="dim mono" title={t.channelTitle}>
          {#if primaryChannel}{t.primaryChannel} »{primaryChannel.name}« · {t.key} ⌗{primaryChannel.fingerprint}{/if}
          {#if myNode}
            · {t.thisNode} {myNode}{/if}
        </p>
      {/if}
      {#if channels.length > 0}
        <p class="dim mono">
          <label title={t.txChannelTitle}>
            {t.txChannel}
            <select
              bind:value={txChannel}
              onchange={() => {
                // A hand-made choice is final: nothing may move the selector
                // afterwards, or a late-arriving channel would silently undo it.
                txChannelChosenByHand = true;
                setTxChannelFn(txChannel);
                // Another channel is another audience: the apps that answered
                // on the old one are no evidence about this one.
                sync?.forgetPeers?.();
                company = { peers: [], lastHeardAgoMs: null };
                restartHeartbeat();
                const ch = channels.find((c) => c.index === txChannel);
                pushLog(w().log.handChannel(txChannel, ch?.name, ch?.fingerprint));
              }}
            >
              {#each channels as ch (ch.index)}
                <option value={ch.index}>
                  {ch.index} »{ch.name}« ⌗{ch.fingerprint}{ch.role === 1 ? ` · ${t.primary}` : ""}
                </option>
              {/each}
            </select>
          </label>
        </p>
      {/if}
      {#if airtimeBlocked}
        <p class="warn" data-testid="airtime-blocked">
          {#if $lang === "de"}
            <strong>Sendezeit aufgebraucht.</strong> Dieser Knoten hat sein gesetzliches
            Stundenkontingent ausgeschöpft{#if dutyCycleText} ({region} · {dutyCycleText}){/if}
            und sendet nicht mehr. Empfangen geht weiter; Hinzufügen und Einladen sind wieder
            möglich <strong>{untilFree}</strong>.
          {:else}
            <strong>Airtime spent.</strong> This node has used its legal hourly
            allowance{#if dutyCycleText} ({region} · {dutyCycleText}){/if} and will
            not transmit. Receiving continues; adding and inviting resume
            <strong>{untilFree}</strong>.
          {/if}
        </p>
      {/if}
      {#if budgetPercent() != null}
        <div class="bar" title={t.budgetTitle}>
          <div class="fill" style={`width:${budgetPercent()}%`}></div>
        </div>
        {#if $lang === "de"}
          <p class="dim">
            Sendezeit-Budget des Kuriers: <strong>{budgetPercent()} % übrig</strong> in dieser Stunde ({region})
          </p>
        {:else}
          <p class="dim">
            courier airtime budget: <strong>{budgetPercent()} % remaining</strong> this hour ({region})
          </p>
        {/if}
      {:else}
        <p class="dim">{t.noDutyCycle}</p>
      {/if}
    {:else}
      <button onclick={connect}>{t.connectNode}</button>
      {#if $lang === "de"}
        <p class="dim">
          öffnet die Bluetooth-Auswahl des Browsers — nur Chrome/Edge, und die erste
          Kopplung braucht immer diesen Knopf. Mit <code>?mesh=bc</code> spielt stattdessen
          ein zweiter Tab das Mesh.
        </p>
      {:else}
        <p class="dim">
          opens the browser's Bluetooth chooser — Chrome/Edge only, and the first
          pairing always needs this button. Append <code>?mesh=bc</code> to fake
          the mesh with a second tab instead.
        </p>
      {/if}
    {/if}
    {#if wakeLockSupported && isMobileDevice}
      <label class="dim awake">
        <input type="checkbox" bind:checked={keepAwake} onchange={toggleAwake} />
        {t.keepAwake}
      </label>
    {/if}
    {#if budget?.misconfigured}
      <p class="warn">
        {#if $lang === "de"}
          ⚠ dieser Knoten meldet die Region <strong>UNSET</strong> — der Kurier sendet
          nicht, solange er das örtliche Sendezeitrecht nicht kennt. Die Region (z. B.
          EU_868) in der Meshtastic-App setzen und neu verbinden. Das Importieren eines
          geteilten Kanals setzt sie oft zurück, deshalb nach jedem Import die Region prüfen.
        {:else}
          ⚠ this node reports region <strong>UNSET</strong> — the courier refuses to
          transmit until it knows the local airtime law. Set the region (e.g.
          EU_868) in the Meshtastic app, then reconnect. Importing a shared
          channel often resets it, so check the region after every import.
        {/if}
      </p>
    {/if}
    {#if reconnecting}
      <p class="dim">{t.linkDroppedNote}</p>
    {/if}
    {#if error}<p class="error">{error}</p>{/if}
    {#if linkLost}
      <button onclick={() => location.reload()}>{t.reload}</button>
    {/if}
    {#if probeResult}
      <p class="dim" data-probe={probeResult}>meshtastic-core probe: {probeResult}</p>
    {/if}
  </section>

  <section>
    <h2>{t.list}</h2>
    {#if db}
      <p class="dim addr">{address}</p>
      <form
        onsubmit={(e) => {
          e.preventDefault();
          add();
        }}
      >
        <input bind:value={newText} placeholder={t.placeholder} aria-label={t.newTodo} />
        <button type="submit" disabled={!newText.trim() || airtimeBlocked}>
          {airtimeBlocked ? t.airtimeSpent : t.add}
        </button>
      </form>
      <ul class="todos">
        {#each todos as todo (todo.key)}
          <li>
            <label>
              <input type="checkbox" checked={todo.done} onchange={() => toggle(todo)} />
              <span class:done={todo.done}>{todo.text}</span>
            </label>
          </li>
        {/each}
      </ul>
      <p class="dim">
        {t.entries(todos.length)} ·
        {carriedBy === "internet" ? t.viaInternet : nodeReady ? t.untilSent : t.untilNode}
      </p>
      <p class="dim">
        {t.linkLine}
        <a data-testid="list-link" href={`#list=${address}`}>{t.linkText}</a>
      </p>
      {#if carriedBy === "mesh" && nodeReady}
        <button
          class="send"
          data-testid="send-changes"
          disabled={unsent === 0 || sending || airtimeBlocked}
          onclick={sendChanges}
        >
          {#if airtimeBlocked}{t.airtimeSpent}{:else if sending}{t.sending}{:else if unsent === 0}{t.nothingToSend}{:else}
            {t.sendChanges(unsent)}
          {/if}
        </button>
      {/if}
      {#if carriedBy === "mesh" && nodeReady}
        <p class="dim" data-testid="company">
          {#if asking}
            {t.askingAir}
          {:else if company.peers.length > 0}
            <strong>{t.appsOutThere(company.peers.length)}</strong>
            {t.keepingList}{#if company.lastHeardAgoMs != null}{t.lastWord(
                Math.round(company.lastHeardAgoMs / 1000),
              )}{/if}
          {:else if askedAt}
            <strong>{t.nobodyAnswered}</strong> {t.radiosWithoutApp}
          {:else}
            {t.nobodySpoken}
          {/if}
        </p>
        <button
          class="ghost"
          data-testid="who-is-there"
          disabled={asking || airtimeBlocked}
          onclick={askWhoIsThere}
          title={t.whoTitle}
        >
          {#if asking}{t.asking}{:else if airtimeBlocked}{t.airtimeSpent}{:else}{t.anyone}{/if}
        </button>
      {/if}
      {#if offerTheMesh}
        <div class="offer" data-testid="mesh-offer">
          {#if $lang === "de"}
            <p>
              Die Peer-to-Peer-Verbindung ist abgerissen — vermutlich das Internet.
              Über das LoRa-Mesh weitermachen?
            </p>
            <p class="dim">
              Der Funk trägt, was sich geändert hat, nicht die ganze Liste, und
              verbraucht ein rationiertes Budget: Änderungen warten dann auf den
              Senden-Knopf.
            </p>
          {:else}
            <p>
              The peer-to-peer connection dropped — probably the internet.
              Continue over the LoRa mesh?
            </p>
            <p class="dim">
              The radio carries what changed, not the whole list, and spends a
              rationed budget: changes then wait for the send button.
            </p>
          {/if}
          {#if nodeReady}
            <button data-testid="accept-mesh" disabled={switching} onclick={() => carryOver("mesh")}>
              {switching ? t.switching : t.continueMesh}
            </button>
          {:else}
            <button
              data-testid="accept-mesh"
              disabled={switching || phase === "connecting"}
              onclick={connectAndCarry}
            >
              {phase === "connecting" ? t.connecting : t.connectContinue}
            </button>
          {/if}
          <!-- Dismissed for this outage: the watcher speaks on change, so the
               question is not asked again until the internet comes back and
               goes a second time. The line below still says it is gone. -->
          <button class="ghost" onclick={() => (offerTheMesh = false)}>{t.stayInternet}</button>
        </div>
      {/if}
      {#if wantsInternet}
        <p class="dim" data-testid="carried-by">
          {t.carriedBy} <strong>{carriedBy === "internet" ? t.theInternet : t.theMesh}</strong>
          {#if carriedBy === "internet"}· {t.peersOverIp(ipPeers.length)}{/if}
          {#if !internetReachable}· <strong>{t.internetGone}</strong>{/if}
        </p>
        <button
          class="ghost"
          data-testid="carry-over"
          disabled={switching || phase === "connecting"}
          onclick={() =>
            carriedBy === "mesh"
              ? carryOver("internet")
              : nodeReady
                ? carryOver("mesh")
                : connectAndCarry()}
        >
          {#if switching}{t.switching}{:else if carriedBy === "mesh"}{t.carryInternet}{:else if nodeReady}{t.carryMesh}{:else}{t.connectCarry}{/if}
        </button>
      {/if}
      {#if nodeReady}
        <button class="ghost" disabled={airtimeBlocked} onclick={() => sendInvite(courier, db.address)}>
          {t.inviteAgain}
        </button>
        <button
          class="ghost"
          data-testid="back-up-and-point"
          disabled={!online || backingUp || airtimeBlocked}
          onclick={backUp}
          title={online ? t.backUpTitle : t.needsInternet}
        >
          {#if backingUp}{t.backingUp}{:else if !online}{t.backUpOffline}{:else}{t.backUp}{/if}
        </button>
      {/if}
      <button class="ghost" onclick={() => location.reload()}>{t.reset}</button>
    {:else if sync}
      <p>{t.joiningDelta}</p>
    {:else if openingLink}
      <p>{t.openingLink}</p>
      <p class="dim addr">{linked}</p>
    {:else if pointer}
      <p>{t.pointerArrived}</p>
      <p class="dim addr">{pointer.address}</p>
      <p class="dim addr">{t.backup} {pointer.cid}</p>
      <button data-testid="restore-from-pointer" onclick={restorePointed} disabled={restoring || !online}>
        {#if restoring}{t.restoring}{:else if !online}{t.restoreOffline}{:else}{t.restore}{/if}
      </button>
      <button class="ghost" onclick={() => (pointer = null)}>{t.ignore}</button>
    {:else if invite}
      <p>
        {inviteFrom === "link" ? t.linkInvite : t.meshInvite}
      </p>
      <p class="dim addr">{invite}</p>
      <button onclick={join} disabled={joining || (carriedBy === "mesh" && !nodeReady)}>
        {joining ? t.joining : t.join}
      </button>
      <button class="ghost" onclick={() => (invite = "")}>{t.ignore}</button>
      {#if carriedBy === "mesh" && !nodeReady}<p class="dim">{t.connectFirst}</p>{/if}
    {:else if phase !== "boot"}
      <button onclick={create} disabled={creating}>
        {creating ? (nodeReady ? t.creatingOnAir : t.creating) : t.create}
      </button>
      <p class="dim">
        {nodeReady ? t.waitForInvite : wantsInternet ? t.noNodeInternet : t.noNodeMesh}
      </p>
    {:else}
      <p class="dim">{t.startingStack}</p>
    {/if}
  </section>

  <section>
    <h2>{t.syncPane} <span class="dim">{t.benchInstrument}</span></h2>
    <p class="dim">
      {t.frames} {totals.framesTx} → · ← {totals.framesRx} · {t.retransmitRounds}
      {totals.retransmitRounds} · {t.estAirtime} {(totals.airtimeSpentMs / 1000).toFixed(1)} s{#if refusals.soft > 0} · {t.radioGaveUp(refusals.soft, refusals.last)}{/if}
    </p>
    <div class="log">
      {#each log as line (line.id)}
        <div><span class="dim">{line.ts}</span> {line.text}</div>
      {/each}
      {#if log.length === 0}<div class="dim">{t.quiet}</div>{/if}
    </div>
  </section>

  {#if mode.kind !== "bc" && neighbours.length > 0}
    <section>
      <h2>
        {t.neighbours} <span class="dim">{t.heardByNode(neighbours.length)}</span>
      </h2>
      {#if $lang === "de"}
        <p class="dim">
          wer sonst auf diesem Kanal funkt — auf einem öffentlichen Kanal ist das das
          Publikum einer Einladung. <strong>Funkgeräte, keine Apps:</strong> ein Knoten
          hier kann jemandes Router sein und gar keine Liste führen. Ob eine andere
          mesh-todo da ist, kann nur diese App beantworten, und <em>Ist da jemand?</em>
          oben fragt danach.
        </p>
      {:else}
        <p class="dim">
          who else is on this channel's air — on a public channel, this is the
          audience an invite has. <strong>Radios, not apps:</strong> a node here
          may be somebody's router and keep no list at all. Whether another
          mesh-todo is out there is a question only that app can answer, and
          <em>Is anyone out there?</em> above asks it.
        </p>
      {/if}
      <button class="ghost" onclick={() => (showNeighbours = !showNeighbours)}>
        {showNeighbours ? t.hide : t.showNodes(neighbours.length)}
      </button>
      {#if showNeighbours}
        <div class="log neighbours">
          {#each neighbours as node (node.num)}
            <div>
              <span class="nn">{node.user?.shortName ?? "?"}</span>
              {node.user?.longName ?? node.user?.id ?? node.num}
              <span class="dim">
                · {heardAgo(node)}{node.hopsAway ? t.hops(node.hopsAway) : ""}{node.snr ? ` · SNR ${node.snr.toFixed(1)}` : ""}{node.viaMqtt ? t.viaMqtt : ""}
              </span>
            </div>
          {/each}
        </div>
      {/if}
    </section>
  {/if}

  <footer>
    <a href="https://github.com/NiKrause/funkpost/issues/1">{t.designIssue}</a>
    · GPL-3.0 ·
    <a href="https://github.com/NiKrause/funkpost">{t.source}</a>
    <span class="build" title={t.buildTitle}>
      funkpost {build.version} ·
      {#if build.commit && build.commit !== "local"}
        <a href="https://github.com/NiKrause/funkpost/commit/{build.commit}">{build.commit}</a>
      {:else}{build.commit}{/if}
      · {build.builtAt}
    </span>
    <p class="ls-credit">{@html creditHTML($lang)}</p>
  </footer>
</main>

<style>
  :global(body) {
    margin: 0;
    background: var(--ls-bg-0);
    color: var(--ls-text);
    font-family: var(--ls-font);
  }
  /* 64 px on top: the Le Space pill sits in the first 56. */
  main {
    max-width: 640px;
    margin: 0 auto;
    padding: 64px 16px 48px;
  }
  h1 {
    margin: 0;
    font-size: 1.6rem;
  }
  .tag {
    margin: 4px 0 0;
    color: var(--ls-text-dim);
    font-size: 0.9rem;
  }
  /* The LED: amber and blinking until another device with this list answers,
     then steady green. With reduced motion the blink becomes a hollow ring, so
     the two states still differ in form and not only in colour. */
  .led-line {
    display: flex;
    align-items: center;
    gap: 10px;
    margin: 14px 0 0;
    color: var(--ls-text-dim);
    font-size: 0.88rem;
  }
  .led {
    flex: none;
    width: 12px;
    height: 12px;
    border-radius: 50%;
    background: var(--ls-amber);
    box-shadow: 0 0 6px color-mix(in srgb, var(--ls-amber) 55%, transparent);
    animation: led-blink 1.2s infinite;
  }
  .led.steady {
    background: var(--ls-green);
    box-shadow: 0 0 8px color-mix(in srgb, var(--ls-green) 60%, transparent);
    animation: none;
  }
  @keyframes led-blink {
    0%, 49% { opacity: 1; }
    50%, 100% { opacity: 0.15; }
  }
  @media (prefers-reduced-motion: reduce) {
    .led {
      box-sizing: border-box;
      background: transparent;
      border: 2px solid var(--ls-amber);
      box-shadow: none;
      animation: none;
    }
    .led.steady {
      background: var(--ls-green);
      border: none;
    }
  }
  /* Coral rail rather than a filled box: it must read as a caveat on the page,
     not as an error the app is reporting about itself. */
  .notice {
    margin-top: 20px;
    padding: 14px 16px;
    border: 1px solid var(--ls-bg-3);
    border-left: 3px solid var(--ls-red);
    border-radius: 10px;
    background: var(--ls-bg-2);
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .notice p {
    margin: 0;
    font-size: 0.86rem;
    line-height: 1.55;
    color: var(--ls-text-dim);
  }
  .notice strong { color: var(--ls-text); }
  .notice a { color: var(--ls-accent); }
  .dismiss {
    align-self: flex-start;
    margin-top: 2px;
    padding: 5px 12px;
    border: 1px solid var(--ls-bg-3);
    border-radius: 999px;
    background: transparent;
    color: var(--ls-text-dim);
    font: inherit;
    font-size: 0.8rem;
    cursor: pointer;
  }
  .dismiss:hover { border-color: var(--ls-accent); color: var(--ls-text); }
  section {
    margin-top: 28px;
    padding: 14px 16px;
    border: 1px solid var(--ls-bg-3);
    border-radius: 10px;
  }
  h2 {
    margin: 0 0 10px;
    font-size: 1rem;
  }
  .dim {
    color: var(--ls-text-dim);
    font-size: 0.85rem;
  }
  .error {
    color: var(--ls-red);
  }
  .warn {
    margin: 10px 0 0;
    padding: 8px 10px;
    border: 1px solid color-mix(in srgb, var(--ls-amber) 45%, var(--ls-bg-0));
    border-radius: 8px;
    background: color-mix(in srgb, var(--ls-amber) 10%, var(--ls-bg-0));
    color: color-mix(in srgb, var(--ls-amber) 75%, var(--ls-text));
    font-size: 0.85rem;
    line-height: 1.5;
  }
  .addr {
    word-break: break-all;
    font-family: var(--ls-font-mono);
  }
  .mono {
    font-family: var(--ls-font-mono);
  }
  .awake {
    display: flex;
    gap: 8px;
    align-items: center;
    margin-top: 8px;
  }
  select {
    padding: 4px 8px;
    border-radius: 6px;
    border: 1px solid var(--ls-bg-3);
    background: var(--ls-bg-2);
    color: inherit;
    font-family: var(--ls-font-mono);
    font-size: 0.8rem;
  }
  button {
    padding: 8px 14px;
    border-radius: 8px;
    border: 1px solid var(--ls-bg-3);
    background: var(--ls-bg-2);
    color: inherit;
    font-size: 0.95rem;
    cursor: pointer;
  }
  button:disabled {
    opacity: 0.4;
    cursor: default;
  }
  /* The only control here that spends airtime, so it is the only one that
     looks like an action rather than a link. */
  .send {
    margin-top: 10px;
    border-color: var(--ls-accent);
    color: var(--ls-text);
  }
  .send:not(:disabled):hover { background: color-mix(in srgb, var(--ls-accent) 12%, var(--ls-bg-2)); }
  .ghost {
    background: none;
    border-color: var(--ls-bg-3);
    color: var(--ls-text-dim);
    margin-top: 8px;
    margin-right: 8px;
  }
  form {
    display: flex;
    gap: 8px;
    margin: 10px 0;
  }
  .offer {
    border: 1px solid var(--ls-accent);
    border-radius: 6px;
    padding: 12px;
    margin: 12px 0;
  }
  .offer p {
    margin: 0 0 8px;
  }
  input[type="text"],
  input:not([type]) {
    flex: 1;
    padding: 8px 10px;
    border-radius: 8px;
    border: 1px solid var(--ls-bg-3);
    background: var(--ls-bg-2);
    color: inherit;
  }
  .todos {
    list-style: none;
    margin: 8px 0;
    padding: 0;
    display: grid;
    gap: 6px;
  }
  .todos label {
    display: flex;
    gap: 10px;
    align-items: center;
  }
  .done {
    text-decoration: line-through;
    color: var(--ls-text-dim);
  }
  .bar {
    height: 8px;
    border-radius: 999px;
    background: var(--ls-bg-2);
    overflow: hidden;
    margin: 8px 0 4px;
  }
  .fill {
    height: 100%;
    background: var(--ls-green);
    transition: width 0.5s;
  }
  .neighbours .nn {
    display: inline-block;
    min-width: 4.5ch;
    font-weight: 650;
    color: var(--ls-accent);
  }
  .log {
    max-height: 220px;
    overflow-y: auto;
    font-family: var(--ls-font-mono);
    font-size: 0.78rem;
    line-height: 1.5;
    background: var(--ls-bg-2);
    border-radius: 8px;
    padding: 8px 10px;
  }
  footer .ls-credit {
    display: flex;
    margin-top: 12px;
  }
  footer {
    margin-top: 28px;
    color: var(--ls-text-dim);
    font-size: 0.8rem;
  }
  footer a {
    color: var(--ls-accent);
  }
  .build {
    display: block;
    margin-top: 6px;
    font-family: var(--ls-font-mono);
    font-size: 0.72rem;
    opacity: 0.75;
  }
  .conns {
    margin: 6px 0 8px;
    padding-left: 18px;
    font-size: 0.85rem;
  }
  .conns li {
    margin: 2px 0;
  }
</style>
