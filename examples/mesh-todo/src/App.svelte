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
  import { creditHTML } from "@le-space/funkpost-brand";
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
    relayIds.includes(c.peer)
      ? "relay"
      : c.addr.includes("/webrtc")
        ? "direct (WebRTC)"
        : c.addr.includes("/p2p-circuit")
          ? "through a relay"
          : "other";
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
    pushLog(`TX channel → ${index} »${ch?.name}« ⌗${ch?.fingerprint} — chosen automatically`);
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
    pushLog(
      `node reports channel ${entry.index} »${entry.name}« ⌗${entry.fingerprint}${entry.role === 1 ? " · primary" : ""}`,
    );
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
        if (keepAwake) pushLog("screen wake lock released by the system");
      });
      pushLog("screen wake lock on");
    } catch (e) {
      keepAwake = false;
      pushLog(`! wake lock refused: ${e.message}`);
    }
  }

  async function toggleAwake() {
    if (keepAwake) {
      await acquireWakeLock();
    } else {
      await wakeSentinel?.release();
      wakeSentinel = null;
      pushLog("screen wake lock off");
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
    if (event.kind === "payload-rx") pushLog(`⇠ payload ${event.bytes} B (msg ${event.msgId})`);
    if (event.kind === "delivered") pushLog(`✓ delivered msg ${event.msgId} after ${event.rounds} round(s)`);
    if (event.kind === "giveup")
      pushLog(
        `✗ gave up on msg ${event.msgId} after ${event.rounds} round(s)${event.reason ? ` — ${event.reason}` : ""}`,
      );
    if (event.kind === "error") pushLog(`! ${describeError(event.error)}`);
  };

  const wireSyncLog = (s) => {
    s.on("message", ({ direction, type, bytes }) =>
      pushLog(`${direction === "out" ? "→" : "←"} ${type} ${bytes} B`),
    );
    s.on("synced", ({ joined }) => pushLog(`⇅ joined ${joined} entr${joined === 1 ? "y" : "ies"}`));
    s.on("error", (e) => pushLog(`! sync: ${e.message}`));
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
    pushLog(`db open: ${opened.address.slice(0, 24)}…`);
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
          pushLog(
            carriedBy === "mesh"
              ? "the node carries the list now — invite sent"
              : "the list has a mesh path now, quiet while the internet carries it — invite sent",
          );
        })
        .catch((e) => pushLog(`! attaching the node failed: ${e.message}`))
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
      pushLog(`! heartbeat: ${e.message}`);
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
    ms == null ? "" : ms < 60_000 ? "just now" : `${Math.round(ms / 60_000)} min ago`;

  const logBeat = (event) => {
    if (event.kind === "beat") {
      pushLog(`♥ beat ${event.beat} of ${event.of} — is another device keeping this list?`);
    }
    if (event.kind === "heard") pushLog(`♥ ${event.type} from device ${event.from}`);
    if (event.kind === "echo") pushLog(`♥ echo to device ${event.to}`);
    if (event.kind === "round" && !event.answered) {
      pushLog(`♥ nobody with this list answered — next heartbeat at ${clockText(event.nextRoundAt)}`);
    }
    if (event.kind === "error") pushLog(`! heartbeat: ${describeError(event.error)}`);
  };

  // The LED: steady only with a node connected and another device keeping this
  // list answering its heartbeat. Everything short of that blinks, and says why.
  const led = $derived.by(() => {
    if (linkLost) return { steady: false, text: "LoRa node lost — reload to reconnect" };
    if (reconnecting) return { steady: false, text: "LoRa node dropped — reconnecting…" };
    if (!nodeReady) {
      return {
        steady: false,
        text: phase === "connecting" ? "connecting to the LoRa node…" : "no LoRa node connected",
      };
    }
    if (!db) return { steady: false, text: "LoRa node connected — no list to listen for yet" };
    if (!beat) return { steady: false, text: "LoRa node connected — starting the heartbeat…" };
    if (beat.lastError) return { steady: false, text: `the heartbeat cannot go out: ${beat.lastError}` };
    const checking = beat.beat > 0 ? ` · checking again, beat ${beat.beat} of ${beat.beatsPerRound}` : "";
    if (beat.verdict === "answered") {
      const others = Math.max(1, beat.peers.length);
      return {
        steady: true,
        text: `${others === 1 ? "another device" : `${others} other devices`} with this list answered ${agoText(beat.lastHeardAgoMs)}${checking}`,
      };
    }
    if (beat.verdict === "alone") {
      return {
        steady: false,
        text: `no other device with this list answered${checking || ` — next heartbeat at ${clockText(beat.nextRoundAt)}`}`,
      };
    }
    return {
      steady: false,
      text: `looking for another device with this list — beat ${beat.beat} of ${beat.beatsPerRound}`,
    };
  });

  onMount(async () => {
    // On a phone the console is invisible; surface anything that would
    // otherwise tear the connection down silently — an exception in a
    // config handler, a rejecting promise, a polyfill edge case.
    const onWinError = (e) =>
      pushLog(`! window ${e.type}: ${describeError(e.reason ?? e.error ?? e.message ?? e)}`);
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
      pushLog(`internet path up — relays from ${relaySource}`);
      selfId = stack.libp2p.peerId.toString();
      relayMultiaddrs().then((addresses) => {
        relayIds = [...new Set(addresses.map((a) => a.match(/\/p2p\/([^/]+)$/)?.[1]).filter(Boolean))];
        pushLog(`${relayIds.length} relay${relayIds.length === 1 ? "" : "s"} known`);
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
          pushLog(
            reachable
              ? `internet back — ${peers} peer${peers === 1 ? "" : "s"} over IP`
              : "internet gone — no peer answers, and a dial to the relay failed too",
          );
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
          pushLog(`node reports region: ${name}`);
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
        onStatus: (name) => pushLog(`node status: ${name}`),
        onReconnecting: (n) => {
          reconnecting = true;
          pushLog(`link dropped — reconnecting (attempt ${n})…`);
        },
        onReconnected: () => {
          reconnecting = false;
          pushLog("reconnected — resuming sync");
          // Re-announce so the peer re-diffs heads and the courier's ARQ
          // re-sends whatever the drop interrupted (e.g. the bootstrap blocks).
          sync?.announce?.();
        },
        onGaveUp: () => {
          reconnecting = false;
          linkLost = true;
          error = "the radio link keeps dropping — this phone's Bluetooth is too unstable; reload to retry, or use desktop Chrome";
          pushLog("gave up reconnecting after repeated drops");
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
        pushLog(`pointer for ${p.address.slice(0, 20)}… → ${p.cid.slice(0, 12)}…`);
      });
      phase = "ready";
      pushLog(`link up: ${linkKind}, region ${region}`);
      wireList();
    } catch (e) {
      error = e.message;
      phase = "idle";
    }
  }

  async function create() {
    error = "";
    creating = true;
    pushLog(
      courier
        ? "creating list — announce and invite go on the air…"
        : "creating list — no node needed; one connected later gives it the mesh",
    );
    try {
      const made = await createList({ orbitdb: stack.orbitdb, courier });
      sync = made.sync;
      if (sync) wireSyncLog(sync);
      attachDb(made.db);
      if (made.sync) pushLog("invite sent over the mesh");
      if (carriedBy === "internet") {
        await carryOverInternet({ db: made.db, sync });
        pushLog(`carried by the internet — OrbitDB's own sync${sync ? ", courier quiet" : ""}`);
      }
    } catch (e) {
      error = e.message;
      pushLog(`! create failed: ${e.message}`);
    } finally {
      creating = false;
    }
  }

  async function join() {
    error = "";
    if (carriedBy === "mesh" && !courier) {
      error = "joining over the mesh needs a node — connect one first";
      return;
    }
    joining = true;
    pushLog("joining — bootstrap request goes on the air…");
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
        pushLog("joined over the internet — OrbitDB is fetching the log");
      } else {
        const joined = await joinList({ orbitdb: stack.orbitdb, courier, address: invite });
        sync = joined.sync;
        wireSyncLog(sync);
        pushLog("joining — waiting for the first delta…");
      }
    } catch (e) {
      error = e.message;
      pushLog(`! join failed: ${e.message}`);
    } finally {
      joining = false;
    }
  }

  /** Open the list a link names: over the internet, with or without a node. */
  async function openLinked(named) {
    error = "";
    openingLink = true;
    pushLog("opening the list from its link — OrbitDB fetches it from the pages that have it…");
    try {
      const joined = await joinOverInternet({ orbitdb: stack.orbitdb, courier, address: named });
      if (joined.sync) {
        sync = joined.sync;
        wireSyncLog(sync);
      }
      attachDb(joined.db);
      pushLog(`list open — the internet carries it${courier ? "" : ", no node needed"}`);
    } catch (e) {
      error = e.message;
      pushLog(`! opening the link failed: ${e.message}`);
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
        pushLog("carried by the internet — the courier is quiet");
      } else {
        await carryOverMesh({ db, sync });
        pushLog("carried by the mesh — OrbitDB's own sync is stopped");
      }
      carriedBy = path;
      if (path === "mesh") {
        offerTheMesh = false;
        company = { peers: [], lastHeardAgoMs: null }; // the other path's silence says nothing
        askWhoIsThere(); // the next thing anyone wants to know, so do not make them ask
      }
    } catch (e) {
      error = e.message;
      pushLog(`! switch failed: ${e.message}`);
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
    pushLog("asking the air: is another mesh-todo keeping this list?");
    try {
      await sync.hello();
      // An answer has to travel, and this carrier is slow on purpose.
      await new Promise((resolve) => setTimeout(resolve, 6000));
      company = sync.presence();
      pushLog(
        company.peers.length > 0
          ? `${company.peers.length} app${company.peers.length === 1 ? "" : "s"} answered: ${company.peers.map((peer) => peer.id).join(", ")}`
          : "nobody answered — radios may be in range, but no app is keeping this list",
      );
    } catch (e) {
      pushLog(`! asking failed: ${e.message}`);
    } finally {
      asking = false;
    }
  }

  /** Back the list up over the internet, and name it over the radio. */
  async function backUp() {
    error = "";
    backingUp = true;
    pushLog("backing up over the internet — the radio only carries the pointer…");
    try {
      const { cid, blocks } = await backUpAndPoint({ orbitdb: stack.orbitdb, db, courier });
      pushLog(`pointer sent: ${blocks} blocks backed up, cid ${cid.slice(0, 12)}…`);
    } catch (e) {
      error = e.message;
      pushLog(`! backup failed: ${e.message}`);
    } finally {
      backingUp = false;
    }
  }

  /** Take the list from the pointer: bytes over HTTPS, nothing over the air. */
  async function restorePointed() {
    error = "";
    restoring = true;
    pushLog("restoring from the pointer — fetching the backup over the internet…");
    try {
      const restored = await restoreFromPointer({ orbitdb: stack.orbitdb, courier, pointer });
      sync = restored.sync;
      wireSyncLog(sync);
      attachDb(restored.db);
      pointer = null;
      pushLog(`restored ${restored.entries} entries from ${restored.blocks} blocks — no radio`);
    } catch (e) {
      error = e.message;
      pushLog(`! restore failed: ${e.message}`);
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
      pushLog(`→ announced${carried ? ` — ${carried} local change(s) offered` : ""}`);
    } catch (e) {
      pushLog(`! send failed: ${describeError(e)}`);
    } finally {
      sending = false;
    }
  }

  const heardAgo = (node) => {
    if (!node.lastHeard) return "—";
    const seconds = Math.max(0, Math.round(nowTick / 1000 - node.lastHeard));
    if (seconds < 90) return `${seconds}s ago`;
    if (seconds < 5400) return `${Math.round(seconds / 60)}m ago`;
    return `${Math.round(seconds / 3600)}h ago`;
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
    return minutes <= 1 ? "in under a minute" : `in about ${minutes} minutes`;
  });
  const dutyCycleText = $derived(
    budget?.dutyCycle == null
      ? ""
      : `${(budget.dutyCycle * 100).toFixed(budget.dutyCycle < 0.05 ? 1 : 0)} % of an hour`,
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
  <p class="tag">
    no servers · no accounts ·
    {wantsInternet ? "internet first, the mesh when it goes" : "no IP path"} — a todo list over LoRa
  </p>
  <p
    class="led-line"
    data-testid="led"
    data-state={led.steady ? "steady" : "blinking"}
    title="Blinks until a LoRa node is connected and another device keeping this list answers its heartbeat. One round an hour: up to five beats a minute apart, until one is answered."
  >
    <span class="led" class:steady={led.steady} aria-hidden="true"></span>
    <span data-testid="led-label">{led.text}</span>
  </p>

  <!-- Dismissible, and it stays dismissed: somebody using this as a bench
       instrument reads it once and then wants the screen back. -->
  {#if showNotice}
    <aside class="notice" data-testid="experimental-notice">
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
      <button class="dismiss" onclick={dismissNotice} data-testid="dismiss-notice">
        Got it — don't show again
      </button>
    </aside>
  {/if}

  {#if wantsInternet}
    <section data-testid="internet">
      <h2>0 · Internet <span class="dim">(the normal path)</span></h2>
      <p class="dim">
        This page is a peer-to-peer node from the moment it opens. It finds the relays
        registered on Aleph, meets other mesh-todo pages on a shared discovery topic, and
        connects to them — directly over WebRTC where it can, through a relay where it
        cannot. A list travels over these connections; the LoRa mesh is for when they are
        gone. A list needs no node: make one below, and its link — or this page's QR code —
        opens it on another device.
      </p>
      <p>
        <strong>{internetReachable ? "online" : "internet gone"}</strong>
        · <span data-testid="relays">relays {relaysConnected} of {relayIds.length} connected</span>
        · <span data-testid="peer-count"
          >{otherPeers.length} other page{otherPeers.length === 1 ? "" : "s"}</span
        >
      </p>
      {#if conns.length > 0}
        <ul class="conns">
          {#each conns as c (c.peer + c.addr)}
            <li><span class="mono">…{c.peer.slice(-8)}</span> · {kindOf(c)}</li>
          {/each}
        </ul>
      {/if}
      {#if selfId}<p class="dim mono">this node …{selfId.slice(-8)}</p>{/if}
    </section>
  {/if}

  <section>
    <h2>1 · Node</h2>
    {#if phase === "boot"}
      <p>starting the local database stack…</p>
    {:else if phase === "connecting"}
      <p>connecting…</p>
    {:else if phase === "ready"}
      <p>
        <strong>{linkKind}</strong> — region <strong>{region}</strong>
        {#if airUtil != null}
          · <span title="the node's own measured TX utilisation — all of its traffic (beacons, telemetry, relaying), not just this app">node airtime {airUtil.toFixed(1)} %</span>
        {/if}
      </p>
      {#if primaryChannel || myNode}
        <p class="dim mono" title="same channel name + key fingerprint on both phones = the nodes can decrypt each other">
          {#if primaryChannel}primary channel »{primaryChannel.name}« · key ⌗{primaryChannel.fingerprint}{/if}
          {#if myNode}
            · this node {myNode}{/if}
        </p>
      {/if}
      {#if channels.length > 0}
        <p class="dim mono">
          <label
            title="transmissions go on this channel — pick the same »name« ⌗fingerprint on both phones. Reception decodes every channel the node holds a key for."
          >
            TX channel:
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
                pushLog(`TX channel → ${txChannel} »${ch?.name}« ⌗${ch?.fingerprint}`);
              }}
            >
              {#each channels as ch (ch.index)}
                <option value={ch.index}>
                  {ch.index} »{ch.name}« ⌗{ch.fingerprint}{ch.role === 1 ? " · primary" : ""}
                </option>
              {/each}
            </select>
          </label>
        </p>
      {/if}
      {#if airtimeBlocked}
        <p class="warn" data-testid="airtime-blocked">
          <strong>Airtime spent.</strong> This node has used its legal hourly
          allowance{#if dutyCycleText} ({region} · {dutyCycleText}){/if} and will
          not transmit. Receiving continues; adding and inviting resume
          <strong>{untilFree}</strong>.
        </p>
      {/if}
      {#if budgetPercent() != null}
        <div class="bar" title="airtime budget left this hour">
          <div class="fill" style={`width:${budgetPercent()}%`}></div>
        </div>
        <p class="dim">
          courier airtime budget: <strong>{budgetPercent()} % remaining</strong> this hour ({region})
        </p>
      {:else}
        <p class="dim">no duty cycle in this region — pacing off, politeness on</p>
      {/if}
    {:else}
      <button onclick={connect}>Connect node</button>
      <p class="dim">
        opens the browser's Bluetooth chooser — Chrome/Edge only, and the first
        pairing always needs this button. Append <code>?mesh=bc</code> to fake
        the mesh with a second tab instead.
      </p>
    {/if}
    {#if wakeLockSupported && isMobileDevice}
      <label class="dim awake">
        <input type="checkbox" bind:checked={keepAwake} onchange={toggleAwake} />
        keep the screen awake — Web Bluetooth pauses when the screen sleeps
      </label>
    {/if}
    {#if budget?.misconfigured}
      <p class="warn">
        ⚠ this node reports region <strong>UNSET</strong> — the courier refuses to
        transmit until it knows the local airtime law. Set the region (e.g.
        EU_868) in the Meshtastic app, then reconnect. Importing a shared
        channel often resets it, so check the region after every import.
      </p>
    {/if}
    {#if reconnecting}
      <p class="dim">link dropped — reconnecting automatically…</p>
    {/if}
    {#if error}<p class="error">{error}</p>{/if}
    {#if linkLost}
      <button onclick={() => location.reload()}>Reload &amp; reconnect</button>
    {/if}
    {#if probeResult}
      <p class="dim" data-probe={probeResult}>meshtastic-core probe: {probeResult}</p>
    {/if}
  </section>

  <section>
    <h2>2 · List</h2>
    {#if db}
      <p class="dim addr">{address}</p>
      <form
        onsubmit={(e) => {
          e.preventDefault();
          add();
        }}
      >
        <input bind:value={newText} placeholder="Milch kaufen…" aria-label="new todo" />
        <button type="submit" disabled={!newText.trim() || airtimeBlocked}>
          {airtimeBlocked ? "Airtime spent" : "Add"}
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
        {todos.length} entr{todos.length === 1 ? "y" : "ies"} ·
        {#if carriedBy === "internet"}changes travel over the internet as you make them{:else if nodeReady}changes stay here until you send them{:else}changes stay here until a node carries them{/if}
      </p>
      <p class="dim">
        The link to this list — or this page's QR code, top right — opens it on another device:
        <a data-testid="list-link" href={`#list=${address}`}>link to this list</a>
      </p>
      {#if carriedBy === "mesh" && nodeReady}
        <button
          class="send"
          data-testid="send-changes"
          disabled={unsent === 0 || sending || airtimeBlocked}
          onclick={sendChanges}
        >
          {#if airtimeBlocked}Airtime spent{:else if sending}sending…{:else if unsent === 0}Nothing to send{:else}
            Send {unsent} change{unsent === 1 ? "" : "s"}
          {/if}
        </button>
      {/if}
      {#if carriedBy === "mesh" && nodeReady}
        <p class="dim" data-testid="company">
          {#if asking}
            asking the air…
          {:else if company.peers.length > 0}
            <strong
              >{company.peers.length} app{company.peers.length === 1 ? "" : "s"} out there</strong
            >
            keeping this list{#if company.lastHeardAgoMs != null}, last word {Math.round(
                company.lastHeardAgoMs / 1000,
              )} s ago{/if}
          {:else if askedAt}
            <strong>nobody answered</strong> — radios can be in range without an app listening
          {:else}
            nobody has spoken here yet
          {/if}
        </p>
        <button
          class="ghost"
          data-testid="who-is-there"
          disabled={asking || airtimeBlocked}
          onclick={askWhoIsThere}
          title="Two small messages, and the only way to tell an app from a radio"
        >
          {#if asking}asking…{:else if airtimeBlocked}Airtime spent{:else}Is anyone out there?{/if}
        </button>
      {/if}
      {#if offerTheMesh}
        <div class="offer" data-testid="mesh-offer">
          <p>
            The peer-to-peer connection dropped — probably the internet.
            Continue over the LoRa mesh?
          </p>
          <p class="dim">
            The radio carries what changed, not the whole list, and spends a
            rationed budget: changes then wait for the send button.
          </p>
          {#if nodeReady}
            <button data-testid="accept-mesh" disabled={switching} onclick={() => carryOver("mesh")}>
              {switching ? "switching…" : "Continue over the mesh"}
            </button>
          {:else}
            <button
              data-testid="accept-mesh"
              disabled={switching || phase === "connecting"}
              onclick={connectAndCarry}
            >
              {phase === "connecting" ? "connecting…" : "Connect a node and continue over the mesh"}
            </button>
          {/if}
          <!-- Dismissed for this outage: the watcher speaks on change, so the
               question is not asked again until the internet comes back and
               goes a second time. The line below still says it is gone. -->
          <button class="ghost" onclick={() => (offerTheMesh = false)}>Stay on the internet</button>
        </div>
      {/if}
      {#if wantsInternet}
        <p class="dim" data-testid="carried-by">
          carried by <strong>{carriedBy === "internet" ? "the internet" : "the mesh"}</strong>
          {#if carriedBy === "internet"}· {ipPeers.length} peer{ipPeers.length === 1 ? "" : "s"} over IP{/if}
          {#if !internetReachable}· <strong>internet gone</strong>{/if}
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
          {#if switching}switching…{:else if carriedBy === "mesh"}Carry it over the internet instead{:else if nodeReady}Carry it over the mesh instead{:else}Connect a node and carry it over the mesh{/if}
        </button>
      {/if}
      {#if nodeReady}
        <button class="ghost" disabled={airtimeBlocked} onclick={() => sendInvite(courier, db.address)}>
          Invite again
        </button>
        <button
          class="ghost"
          data-testid="back-up-and-point"
          disabled={!online || backingUp || airtimeBlocked}
          onclick={backUp}
          title={online ? "Backs up over the internet, then names it over the radio in one frame" : "Needs internet"}
        >
          {#if backingUp}backing up…{:else if !online}Back up (needs internet){:else}Back up & beam pointer{/if}
        </button>
      {/if}
      <button class="ghost" onclick={() => location.reload()}>Reset (drops local copy)</button>
    {:else if sync}
      <p>joining — the first delta carries manifest, access controller and entries…</p>
    {:else if openingLink}
      <p>opening the list from its link — OrbitDB fetches it from the pages that have it…</p>
      <p class="dim addr">{linked}</p>
    {:else if pointer}
      <p>a pointer arrived over the mesh — the list itself is on the internet:</p>
      <p class="dim addr">{pointer.address}</p>
      <p class="dim addr">backup {pointer.cid}</p>
      <button data-testid="restore-from-pointer" onclick={restorePointed} disabled={restoring || !online}>
        {#if restoring}Restoring…{:else if !online}Restore (needs internet){:else}Restore from the pointer{/if}
      </button>
      <button class="ghost" onclick={() => (pointer = null)}>Ignore</button>
    {:else if invite}
      <p>
        {inviteFrom === "link"
          ? "a link names this list — without an internet path only the mesh can bring it here:"
          : "invitation from the mesh:"}
      </p>
      <p class="dim addr">{invite}</p>
      <button onclick={join} disabled={joining || (carriedBy === "mesh" && !nodeReady)}>
        {joining ? "Joining…" : "Join this list"}
      </button>
      <button class="ghost" onclick={() => (invite = "")}>Ignore</button>
      {#if carriedBy === "mesh" && !nodeReady}<p class="dim">connect a node first.</p>{/if}
    {:else if phase !== "boot"}
      <button onclick={create} disabled={creating}>
        {creating ? (nodeReady ? "Creating — first frames on the air…" : "Creating…") : "Create a list"}
      </button>
      <p class="dim">
        {#if nodeReady}…or wait for an invitation to arrive over the mesh.{:else if wantsInternet}No node needed: the internet carries the list, and its link — or this page's QR code — opens it on another device. A node connected later adds the mesh.{:else}No node needed to make it; one connected later carries it over the mesh.{/if}
      </p>
    {:else}
      <p class="dim">starting the local database stack…</p>
    {/if}
  </section>

  <section>
    <h2>3 · Sync pane <span class="dim">(the bench instrument)</span></h2>
    <p class="dim">
      frames {totals.framesTx} → · ← {totals.framesRx} · retransmit rounds
      {totals.retransmitRounds} · est. airtime {(totals.airtimeSpentMs / 1000).toFixed(1)} s{#if refusals.soft > 0} · radio gave up on {refusals.soft} frame{refusals.soft === 1 ? "" : "s"} ({refusals.last}){/if}
    </p>
    <div class="log">
      {#each log as line (line.id)}
        <div><span class="dim">{line.ts}</span> {line.text}</div>
      {/each}
      {#if log.length === 0}<div class="dim">quiet.</div>{/if}
    </div>
  </section>

  {#if mode.kind !== "bc" && neighbours.length > 0}
    <section>
      <h2>
        4 · Mesh neighbours <span class="dim">({neighbours.length} heard by this node)</span>
      </h2>
      <p class="dim">
        who else is on this channel's air — on a public channel, this is the
        audience an invite has. <strong>Radios, not apps:</strong> a node here
        may be somebody's router and keep no list at all. Whether another
        mesh-todo is out there is a question only that app can answer, and
        <em>Is anyone out there?</em> above asks it.
      </p>
      <button class="ghost" onclick={() => (showNeighbours = !showNeighbours)}>
        {showNeighbours ? "Hide" : `Show ${neighbours.length} nodes`}
      </button>
      {#if showNeighbours}
        <div class="log neighbours">
          {#each neighbours as node (node.num)}
            <div>
              <span class="nn">{node.user?.shortName ?? "?"}</span>
              {node.user?.longName ?? node.user?.id ?? node.num}
              <span class="dim">
                · {heardAgo(node)}{node.hopsAway ? ` · ${node.hopsAway} hop${node.hopsAway === 1 ? "" : "s"}` : ""}{node.snr ? ` · SNR ${node.snr.toFixed(1)}` : ""}{node.viaMqtt ? " · via mqtt" : ""}
              </span>
            </div>
          {/each}
        </div>
      {/if}
    </section>
  {/if}

  <footer>
    <a href="https://github.com/NiKrause/funkpost/issues/1">design issue #1</a>
    · GPL-3.0 ·
    <a href="https://github.com/NiKrause/funkpost">source</a>
    <span class="build" title="version · commit · built (UTC)">
      funkpost {build.version} ·
      {#if build.commit && build.commit !== "local"}
        <a href="https://github.com/NiKrause/funkpost/commit/{build.commit}">{build.commit}</a>
      {:else}{build.commit}{/if}
      · {build.builtAt}
    </span>
    <p class="ls-credit">{@html creditHTML("en")}</p>
  </footer>
</main>

<style>
  :global(body) {
    margin: 0;
    background: #0B0E15;
    color: #EDF1F8;
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
    color: #A8B3C7;
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
    color: #A8B3C7;
    font-size: 0.88rem;
  }
  .led {
    flex: none;
    width: 12px;
    height: 12px;
    border-radius: 50%;
    background: #f0c674;
    box-shadow: 0 0 6px rgba(240, 198, 116, 0.55);
    animation: led-blink 1.2s infinite;
  }
  .led.steady {
    background: #3EDC97;
    box-shadow: 0 0 8px rgba(62, 220, 151, 0.6);
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
      border: 2px solid #f0c674;
      box-shadow: none;
      animation: none;
    }
    .led.steady {
      background: #3EDC97;
      border: none;
    }
  }
  /* Coral rail rather than a filled box: it must read as a caveat on the page,
     not as an error the app is reporting about itself. */
  .notice {
    margin-top: 20px;
    padding: 14px 16px;
    border: 1px solid #232B3D;
    border-left: 3px solid #FF6B5B;
    border-radius: 10px;
    background: #141926;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .notice p {
    margin: 0;
    font-size: 0.86rem;
    line-height: 1.55;
    color: #A8B3C7;
  }
  .notice strong { color: #EDF1F8; }
  .notice a { color: #58C7F3; }
  .dismiss {
    align-self: flex-start;
    margin-top: 2px;
    padding: 5px 12px;
    border: 1px solid #232B3D;
    border-radius: 999px;
    background: transparent;
    color: #A8B3C7;
    font: inherit;
    font-size: 0.8rem;
    cursor: pointer;
  }
  .dismiss:hover { border-color: #58C7F3; color: #EDF1F8; }
  section {
    margin-top: 28px;
    padding: 14px 16px;
    border: 1px solid #232B3D;
    border-radius: 10px;
  }
  h2 {
    margin: 0 0 10px;
    font-size: 1rem;
  }
  .dim {
    color: #A8B3C7;
    font-size: 0.85rem;
  }
  .error {
    color: #FF6B5B;
  }
  .warn {
    margin: 10px 0 0;
    padding: 8px 10px;
    border: 1px solid #7a5a1a;
    border-radius: 8px;
    background: #241d0d;
    color: #f0c674;
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
    border: 1px solid #232B3D;
    background: #141926;
    color: inherit;
    font-family: var(--ls-font-mono);
    font-size: 0.8rem;
  }
  button {
    padding: 8px 14px;
    border-radius: 8px;
    border: 1px solid #232B3D;
    background: #141926;
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
    border-color: #58C7F3;
    color: #EDF1F8;
  }
  .send:not(:disabled):hover { background: #1a2436; }
  .ghost {
    background: none;
    border-color: #232B3D;
    color: #A8B3C7;
    margin-top: 8px;
    margin-right: 8px;
  }
  form {
    display: flex;
    gap: 8px;
    margin: 10px 0;
  }
  .offer {
    border: 1px solid var(--accent, #888);
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
    border: 1px solid #232B3D;
    background: #141926;
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
    color: #A8B3C7;
  }
  .bar {
    height: 8px;
    border-radius: 999px;
    background: #141926;
    overflow: hidden;
    margin: 8px 0 4px;
  }
  .fill {
    height: 100%;
    background: #3EDC97;
    transition: width 0.5s;
  }
  .neighbours .nn {
    display: inline-block;
    min-width: 4.5ch;
    font-weight: 650;
    color: #58C7F3;
  }
  .log {
    max-height: 220px;
    overflow-y: auto;
    font-family: var(--ls-font-mono);
    font-size: 0.78rem;
    line-height: 1.5;
    background: #141926;
    border-radius: 8px;
    padding: 8px 10px;
  }
  footer .ls-credit {
    display: flex;
    margin-top: 12px;
  }
  footer {
    margin-top: 28px;
    color: #A8B3C7;
    font-size: 0.8rem;
  }
  footer a {
    color: #58C7F3;
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
