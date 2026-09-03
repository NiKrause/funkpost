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
  } from "./stack.js";

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
  let log = $state([]);
  let totals = $state({ framesTx: 0, framesRx: 0, airtimeSpentMs: 0, retransmitRounds: 0 });

  const stamp = () =>
    new Date().toLocaleTimeString(undefined, { hour12: false }) +
    "." +
    String(Date.now() % 1000).padStart(3, "0");

  const pushLog = (text) => {
    log.unshift({ ts: stamp(), text });
    if (log.length > 120) log.pop();
  };

  const onCourierEvent = (event) => {
    if (event.kind === "payload-rx") pushLog(`⇠ payload ${event.bytes} B (msg ${event.msgId})`);
    if (event.kind === "delivered") pushLog(`✓ delivered msg ${event.msgId} after ${event.rounds} round(s)`);
    if (event.kind === "giveup") pushLog(`✗ gave up on msg ${event.msgId} after ${event.rounds} rounds`);
    if (event.kind === "error") pushLog(`! ${event.error?.message ?? event.error}`);
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
    stack = await createDatabaseStack();
    phase = "idle";
    if (mode.kind === "bc") connect();
    const ticker = setInterval(() => {
      if (courier) {
        budget = courier.budget();
        totals = { ...courier.stats };
      }
      if (sync && !db && sync.db) attachDb(sync.db);
    }, 1000);
    return () => clearInterval(ticker);
  });

  async function connect() {
    error = "";
    phase = "connecting";
    try {
      const connected = await connectCourier({
        mode,
        onEvent: onCourierEvent,
        onTelemetry: (value) => (airUtil = value),
      });
      courier = connected.courier;
      linkKind = connected.kind;
      region = connected.region;
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
    try {
      const made = await createList({ orbitdb: stack.orbitdb, courier });
      sync = made.sync;
      wireSyncLog(sync);
      attachDb(made.db);
      pushLog("invite sent over the mesh");
    } catch (e) {
      error = e.message;
    }
  }

  async function join() {
    error = "";
    try {
      const joined = await joinList({ orbitdb: stack.orbitdb, courier, address: invite });
      sync = joined.sync;
      wireSyncLog(sync);
      pushLog("joining — waiting for the first delta…");
    } catch (e) {
      error = e.message;
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
          · node airtime {airUtil.toFixed(1)} %
        {/if}
      </p>
      {#if budgetPercent() != null}
        <div class="bar" title="airtime budget left this hour">
          <div class="fill" style={`width:${budgetPercent()}%`}></div>
        </div>
        <p class="dim">{budgetPercent()} % of this hour's airtime budget left ({region})</p>
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
    {#if error}<p class="error">{error}</p>{/if}
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
        <button type="submit" disabled={!newText.trim()}>Add</button>
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
      <button class="ghost" onclick={() => sendInvite(courier, db.address)}>Invite again</button>
      <button class="ghost" onclick={() => location.reload()}>Reset (drops local copy)</button>
    {:else if sync}
      <p>joining — the first delta carries manifest, access controller and entries…</p>
    {:else if invite}
      <p>invitation from the mesh:</p>
      <p class="dim addr">{invite}</p>
      <button onclick={join}>Join this list</button>
      <button class="ghost" onclick={() => (invite = "")}>Ignore</button>
    {:else if phase === "ready"}
      <button onclick={create}>Create a list</button>
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
      {#each log as line (line.ts + line.text)}
        <div><span class="dim">{line.ts}</span> {line.text}</div>
      {/each}
      {#if log.length === 0}<div class="dim">quiet.</div>{/if}
    </div>
  </section>

  <footer>
    <a href="https://github.com/NiKrause/libp2p-webrtc-qr-meshtastic/issues/1">design issue #1</a>
    · GPL-3.0 ·
    <a href="https://github.com/NiKrause/libp2p-webrtc-qr-meshtastic">source</a>
  </footer>
</main>

<style>
  :global(body) {
    margin: 0;
    background: #0b0e15;
    color: #e8eaf0;
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
    color: #9aa3b5;
    font-size: 0.9rem;
  }
  section {
    margin-top: 28px;
    padding: 14px 16px;
    border: 1px solid #232a3a;
    border-radius: 10px;
  }
  h2 {
    margin: 0 0 10px;
    font-size: 1rem;
  }
  .dim {
    color: #9aa3b5;
    font-size: 0.85rem;
  }
  .error {
    color: #ff7a7a;
  }
  .addr {
    word-break: break-all;
    font-family: ui-monospace, monospace;
  }
  button {
    padding: 8px 14px;
    border-radius: 8px;
    border: 1px solid #3a4358;
    background: #1a2233;
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
    border-color: #2a3245;
    color: #9aa3b5;
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
    border: 1px solid #3a4358;
    background: #10141f;
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
    color: #9aa3b5;
  }
  .bar {
    height: 8px;
    border-radius: 999px;
    background: #1a2233;
    overflow: hidden;
    margin: 8px 0 4px;
  }
  .fill {
    height: 100%;
    background: #5dd39e;
    transition: width 0.5s;
  }
  .log {
    max-height: 220px;
    overflow-y: auto;
    font-family: ui-monospace, monospace;
    font-size: 0.78rem;
    line-height: 1.5;
    background: #10141f;
    border-radius: 8px;
    padding: 8px 10px;
  }
  footer {
    margin-top: 28px;
    color: #9aa3b5;
    font-size: 0.8rem;
  }
  footer a {
    color: #9ab0dd;
  }
</style>
