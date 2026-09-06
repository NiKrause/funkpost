<!-- SPDX-License-Identifier: GPL-3.0-only -->
<script>
  /**
   * mesh-todo: two phones, two nodes, no IP path — and the demo is also the
   * bench instrument. The sync pane shows every protocol message with its
   * cost, because the two hardware gates in issue #1 are read off exactly
   * these numbers.
   */
  import { onMount } from "svelte";
  import {
    createDatabaseStack,
    connectCourier,
    createList,
    joinList,
    sendInvite,
    watchInvites,
    probeMeshtasticCore,
  } from "./stack.js";
  import { describeMeshtasticError } from "@le-space/funkpost";

  const build = __BUILD_INFO__;
  const params = new URLSearchParams(location.search);
  const mode =
    params.get("mesh") === "bc"
      ? {
          kind: "bc",
          room: params.get("room") ?? "mesh-todo",
          loss: Number(params.get("loss") ?? 0),
          preset: params.get("preset") ?? undefined,
        }
      : { kind: "ble" };

  let phase = $state("boot"); // boot → idle → connecting → ready
  let linkKind = $state("");
  let region = $state("");
  let budget = $state(null);
  let airUtil = $state(null);
  let error = $state("");

  let stack = null;
  let courier = null;
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
  let neighbours = $state([]);
  let primaryChannel = $state(null); // { name, fingerprint }
  let channels = $state([]); // [{ index, name, fingerprint, role }]
  let txChannel = $state(0);
  let myNode = $state("");
  let setTxChannelFn = () => {};
  const channelMap = new Map();

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
  };

  onMount(async () => {
    // On a phone the console is invisible; surface anything that would
    // otherwise tear the connection down silently — an exception in a
    // config handler, a rejecting promise, a polyfill edge case.
    const onWinError = (e) =>
      pushLog(`! window ${e.type}: ${describeError(e.reason ?? e.error ?? e.message ?? e)}`);
    window.addEventListener("error", onWinError);
    window.addEventListener("unhandledrejection", onWinError);

    if (params.get("probe") === "meshtastic-core") {
      try {
        probeResult = await probeMeshtasticCore();
      } catch (e) {
        probeResult = `CRASH: ${e.message}`;
      }
    }
    stack = await createDatabaseStack();
    phase = "idle";
    if (mode.kind === "bc") connect();
    const ticker = setInterval(() => {
      if (courier) {
        budget = courier.budget();
        totals = { ...courier.stats };
        // One frame is what a single todo costs.
        if (courier.timeUntilAffordable) blockedForMs = courier.timeUntilAffordable();
      }
      if (sync && !db && sync.db) attachDb(sync.db);
      nowTick = Date.now();
    }, 1000);
    document.addEventListener("visibilitychange", reacquireOnReturn);
    return () => {
      clearInterval(ticker);
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
        onChannel: async (channel) => {
          if (channel.role === 0) return; // DISABLED
          const psk = channel.settings?.psk ?? new Uint8Array();
          const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", psk));
          const entry = {
            index: channel.index,
            role: channel.role,
            name: channel.settings?.name || "(default)",
            fingerprint: [...digest.slice(0, 2)]
              .map((b) => b.toString(16).padStart(2, "0"))
              .join(""),
          };
          channelMap.set(entry.index, entry);
          channels = [...channelMap.values()].sort((a, b) => a.index - b.index);
          if (entry.role === 1) {
            primaryChannel = { name: entry.name, fingerprint: entry.fingerprint };
          }
          pushLog(
            `node reports channel ${entry.index} »${entry.name}« ⌗${entry.fingerprint}${entry.role === 1 ? " · primary" : ""}`,
          );
        },
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
      linkKind = connected.kind;
      region = connected.region;
      setTxChannelFn = connected.setTxChannel ?? (() => {});
      budget = courier.budget();
      watchInvites(courier, (addr) => {
        if (!db) invite = addr;
      });
      phase = "ready";
      pushLog(`link up: ${linkKind}, region ${region}`);
    } catch (e) {
      error = e.message;
      phase = "idle";
    }
  }

  async function create() {
    error = "";
    creating = true;
    pushLog("creating list — announce and invite go on the air…");
    try {
      const made = await createList({ orbitdb: stack.orbitdb, courier });
      sync = made.sync;
      wireSyncLog(sync);
      attachDb(made.db);
      pushLog("invite sent over the mesh");
    } catch (e) {
      error = e.message;
      pushLog(`! create failed: ${e.message}`);
    } finally {
      creating = false;
    }
  }

  async function join() {
    error = "";
    joining = true;
    pushLog("joining — bootstrap request goes on the air…");
    try {
      const joined = await joinList({ orbitdb: stack.orbitdb, courier, address: invite });
      sync = joined.sync;
      wireSyncLog(sync);
      pushLog("joining — waiting for the first delta…");
    } catch (e) {
      error = e.message;
      pushLog(`! join failed: ${e.message}`);
    } finally {
      joining = false;
    }
  }

  async function add() {
    const text = newText.trim();
    if (!text || !db) return;
    newText = "";
    await db.put(`t${Date.now()}`, { text, done: false, ts: Date.now() });
  }

  async function toggle(todo) {
    await db.put(todo.key, { text: todo.text, done: !todo.done, ts: todo.ts });
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
</script>

<main>
  <h1>mesh-todo</h1>
  <p class="tag">no servers · no accounts · no IP path — a todo list over LoRa</p>

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
                setTxChannelFn(txChannel);
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
      <p class="dim">{todos.length} entr{todos.length === 1 ? "y" : "ies"} · every change crosses the mesh</p>
      <button class="ghost" disabled={airtimeBlocked} onclick={() => sendInvite(courier, db.address)}>
        Invite again
      </button>
      <button class="ghost" onclick={() => location.reload()}>Reset (drops local copy)</button>
    {:else if sync}
      <p>joining — the first delta carries manifest, access controller and entries…</p>
    {:else if invite}
      <p>invitation from the mesh:</p>
      <p class="dim addr">{invite}</p>
      <button onclick={join} disabled={joining}>{joining ? "Joining…" : "Join this list"}</button>
      <button class="ghost" onclick={() => (invite = "")}>Ignore</button>
    {:else if phase === "ready"}
      <button onclick={create} disabled={creating}>{creating ? "Creating — first frames on the air…" : "Create a list"}</button>
      <p class="dim">…or wait for an invitation to arrive over the mesh.</p>
    {:else}
      <p class="dim">connect a node first.</p>
    {/if}
  </section>

  <section>
    <h2>3 · Sync pane <span class="dim">(the bench instrument)</span></h2>
    <p class="dim">
      frames {totals.framesTx} → · ← {totals.framesRx} · retransmit rounds
      {totals.retransmitRounds} · est. airtime {(totals.airtimeSpentMs / 1000).toFixed(1)} s
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
        audience an invite has.
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
  </footer>
</main>

<style>
  :global(body) {
    margin: 0;
    background: #0B0E15;
    color: #EDF1F8;
    font-family:
      system-ui,
      -apple-system,
      sans-serif;
  }
  main {
    max-width: 640px;
    margin: 0 auto;
    padding: 20px 16px 48px;
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
    font-family: ui-monospace, monospace;
  }
  .mono {
    font-family: ui-monospace, monospace;
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
    font-family: ui-monospace, monospace;
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
    font-family: ui-monospace, monospace;
    font-size: 0.78rem;
    line-height: 1.5;
    background: #141926;
    border-radius: 8px;
    padding: 8px 10px;
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
    font-family: ui-monospace, monospace;
    font-size: 0.72rem;
    opacity: 0.75;
  }
</style>
