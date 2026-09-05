<!-- SPDX-License-Identifier: GPL-3.0-only -->
<script>
  /**
   * Two roles on one page: the salon keeps the book, a customer takes a slot.
   * Every byte between them crosses a LoRa mesh — the radio strip at the
   * bottom prices it, because a demo that hides the transport is lying about
   * what it is.
   */
  import { onMount } from "svelte";
  import {
    createStack,
    connectCourier,
    todayISO,
    downloadFile,
  } from "./stack.js";
  import { DEFAULT_SHOP, serviceById } from "./domain/slots.js";
  import { CONFIRMED, PENDING, DECLINED, CANCELLED, SUPERSEDED } from "./domain/arbitration.js";
  import { toBase64Url, fromBase64Url } from "./domain/capability.js";
  import { bookingLink, parseBookingLink } from "./domain/link.js";

  const build = __BUILD_INFO__;
  const params = new URLSearchParams(location.search);
  const mode =
    params.get("mesh") === "bc"
      ? {
          kind: "bc",
          room: params.get("room") ?? "mesh-appointments",
          loss: Number(params.get("loss") ?? 0),
          preset: params.get("preset") ?? undefined,
        }
      : { kind: "ble" };
  const pinnedToday = params.get("today");
  const room = mode.kind === "bc" ? mode.room : "ble";
  const SHOP_ID = "salon-funkpost";

  // The link out of a calendar note. Everything after `#` stayed in this
  // browser — it was never sent to the host serving this page — so the token
  // arriving here is the capability itself, not a reference to one.
  const arriving = parseBookingLink(location.hash);

  const fromISO = todayISO(DEFAULT_SHOP.tz, pinnedToday);

  let role = $state(
    arriving ? "customer" : (params.get("role") ?? localStorage.getItem(`role:${room}`) ?? ""),
  );
  let phase = $state("idle"); // idle → connecting → ready
  let error = $state("");
  let linkKind = $state("");
  let region = $state("");
  let live = null; // { book, sync, provider, courier, … }
  let salonToken = null;

  let state = $state(null); // the computed view
  let serviceId = $state(DEFAULT_SHOP.services[0].id);
  let day = $state("");
  let slotIndex = $state(null);
  let handle = $state("");
  let busyAction = $state(false);

  let mine = $state([]); // [{ id, token }] — this browser's bookings
  let log = $state([]);
  let logSeq = 0;
  let showRadio = $state(false);
  let totals = $state({ framesTx: 0, framesRx: 0, retransmitRounds: 0, airtimeSpentMs: 0 });
  let syncStats = $state({ payloadsSent: 0, payloadsReceived: 0 });

  const stamp = () => new Date().toLocaleTimeString(undefined, { hour12: false });
  const pushLog = (text) => {
    log.unshift({ id: logSeq++, ts: stamp(), text });
    if (log.length > 100) log.pop();
  };

  // Namespaced by role as well as room: one browser may legitimately hold both
  // sides of the demo, and the salon's storage is not the customer's.
  const myKey = () => `bookings:${room}:${role || "anon"}`;
  const loadMine = () => {
    try {
      mine = JSON.parse(localStorage.getItem(myKey()) ?? "[]");
    } catch {
      mine = [];
    }
  };
  const rememberMine = (id, token) => {
    mine = [...mine, { id, token: toBase64Url(token) }];
    localStorage.setItem(myKey(), JSON.stringify(mine));
  };

  const stack = createStack({ fromISO });

  const refresh = async () => {
    if (!live) return;
    state = await live.book.state(fromISO, DEFAULT_SHOP.horizonDays);
    if (!day && state.grid.length > 0) day = state.grid[0].iso;
    if (live.courier?.stats) totals = { ...live.courier.stats };
    if (live.sync?.stats) syncStats = { ...live.sync.stats };
  };

  /** Days the grid actually offers, with how many slots each still has. */
  const openDays = $derived.by(() => {
    if (!state) return [];
    const seen = new Map();
    for (const slot of state.grid) {
      if (!seen.has(slot.iso)) seen.set(slot.iso, { iso: slot.iso, free: 0 });
    }
    for (const slot of state.offerable(serviceId)) seen.get(slot.iso).free++;
    return [...seen.values()].slice(0, 14);
  });

  const slotsForDay = $derived.by(() => {
    if (!state || !day) return [];
    const offerable = new Set(state.offerable(serviceId).map((s) => s.index));
    return state.grid
      .filter((slot) => slot.iso === day)
      .map((slot) => ({ ...slot, free: offerable.has(slot.index) }));
  });

  const myBookings = $derived.by(() => {
    if (!state) return [];
    const ids = new Set(mine.map((m) => m.id));
    return state.bookings.filter((b) => ids.has(b.id));
  });

  const pending = $derived.by(() =>
    state ? state.bookings.filter((b) => b.status === PENDING) : [],
  );

  const agenda = $derived.by(() => {
    if (!state || !day) return [];
    // Only bookings that actually HOLD their slot get a row. A cancelled or
    // declined one leaves a name on a time the salon can sell again, which
    // reads as booked and is not.
    const byIndex = new Map(
      state.bookings
        .filter((b) => b.status === CONFIRMED || b.status === PENDING)
        .map((b) => [b.slotIndex, b]),
    );
    return state.grid
      .filter((slot) => slot.iso === day)
      .map((slot) => ({ slot, booking: byIndex.get(slot.index) ?? null }));
  });

  const timeOf = (slot) =>
    `${String(Math.floor(slot.minuteOfDay / 60)).padStart(2, "0")}:${String(slot.minuteOfDay % 60).padStart(2, "0")}`;

  const dayLabel = (iso) => {
    const [y, m, d] = iso.split("-").map(Number);
    const at = new Date(Date.UTC(y, m - 1, d));
    return {
      weekday: ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"][at.getUTCDay()],
      day: d,
    };
  };

  const STATUS_TEXT = {
    [CONFIRMED]: "bestätigt",
    [PENDING]: "wartet auf den Salon",
    [DECLINED]: "abgelehnt",
    [CANCELLED]: "abgesagt",
    [SUPERSEDED]: "Zeit war vergeben",
  };

  onMount(() => {
    loadMine();
    // A link may hand us a booking this device has never seen. Adopt the
    // capability so it shows up as ours and can be changed or cancelled —
    // that is the whole point of the token being a key rather than a lookup.
    if (arriving && !mine.some((m) => m.id === arriving.bookingId)) {
      mine = [...mine, { id: arriving.bookingId, token: toBase64Url(arriving.token) }];
      localStorage.setItem(myKey(), JSON.stringify(mine));
    }
    window.addEventListener("error", (e) => pushLog(`! ${e.message ?? e.type}`));
    if (mode.kind === "bc" && role) connect();
    const ticker = setInterval(() => {
      if (live?.courier?.stats) totals = { ...live.courier.stats };
      if (live?.sync?.stats) syncStats = { ...live.sync.stats };
    }, 1000);
    return () => clearInterval(ticker);
  });

  function chooseRole(next) {
    role = next;
    localStorage.setItem(`role:${room}`, next);
    if (mode.kind === "bc") connect();
  }

  async function connect() {
    if (phase !== "idle") return;
    error = "";
    phase = "connecting";
    try {
      live = await connectCourier({
        stack,
        mode,
        onEvent: (event) => {
          if (event.kind === "giveup") pushLog(`✗ ${event.msgId} nach ${event.rounds} Runden aufgegeben`);
          if (event.kind === "accepted") pushLog(`⇠ Eintrag übernommen (${event.id})`);
          if (event.kind === "rejected") pushLog(`⊘ Eintrag verworfen — Signatur passt nicht`);
          if (event.kind === "sent" && event.tag === 0x10) pushLog(`→ Digest ${event.bytes} B`);
          if (event.kind === "sent" && event.tag === 0x12) pushLog(`→ Buchung ${event.bytes} B`);
          if (event.kind === "error") pushLog(`! ${event.error?.message ?? event.error}`);
        },
        onChange: () => refresh(),
        onRegion: (name) => {
          region = name;
          pushLog(`Knoten meldet Region ${name}`);
        },
        onStatus: (name) => pushLog(`Knoten: ${name}`),
        onError: (message) => pushLog(`! ${message}`),
        onReconnecting: (n) => pushLog(`Verbindung weg — Versuch ${n}…`),
        onReconnected: () => pushLog("wieder verbunden"),
        onGaveUp: () => {
          error = "Der Funkkontakt bricht immer wieder ab — bitte neu laden.";
        },
      });
      linkKind = live.kind;
      region = live.region;

      if (role === "salon") {
        const saved = localStorage.getItem(`salon:${room}`);
        salonToken = saved
          ? await live.book.becomeSalon(fromBase64Url(saved))
          : await live.book.becomeSalon();
        localStorage.setItem(`salon:${room}`, toBase64Url(salonToken));
        pushLog("Salon-Identität veröffentlicht");
      }

      // A booking may arrive at any moment; the Yjs rules likewise.
      stack.doc.on("update", () => refresh());
      // Compute the view BEFORE announcing readiness: the template reads
      // state.shop directly, and a single tick of `ready` with a null state
      // is a crash rather than a flicker.
      await refresh();
      phase = "ready";
      pushLog(`Funk offen: ${linkKind}`);
    } catch (e) {
      error = e.message;
      phase = "idle";
    }
  }

  async function book() {
    if (slotIndex == null || !handle.trim()) return;
    busyAction = true;
    try {
      const { id, token } = await live.book.request({
        fromISO,
        days: DEFAULT_SHOP.horizonDays,
        slotIndex,
        serviceId,
        handle: handle.trim(),
      });
      rememberMine(id, token);
      slotIndex = null;
      pushLog("Anfrage ist auf der Luft");
      await refresh();
    } catch (e) {
      error = e.message;
    } finally {
      busyAction = false;
    }
  }

  async function decide(id, status) {
    busyAction = true;
    try {
      await live.book.decide(id, status, { salonToken });
      pushLog(status === CONFIRMED ? "bestätigt — Antwort geht raus" : "abgelehnt — Antwort geht raus");
      await refresh();
    } catch (e) {
      error = e.message;
    } finally {
      busyAction = false;
    }
  }

  async function cancel(entry) {
    busyAction = true;
    try {
      await live.book.cancel(entry.id, fromBase64Url(entry.token));
      pushLog("Absage ist auf der Luft");
      await refresh();
    } catch (e) {
      error = e.message;
    } finally {
      busyAction = false;
    }
  }

  async function saveIcs(entry) {
    const file = await live.book.icsFor(entry.id, {
      fromISO,
      days: DEFAULT_SHOP.horizonDays,
      token: fromBase64Url(entry.token),
      shopId: SHOP_ID,
      role: role === "salon" ? "salon" : "customer",
    });
    downloadFile(file.filename, file.text);
    pushLog(`${file.filename} gespeichert`);
  }

  const linkFor = (entry) =>
    bookingLink({ shopId: SHOP_ID, bookingId: entry.id, token: fromBase64Url(entry.token) });

  const tokenOf = (id) => mine.find((m) => m.id === id) ?? null;
</script>

<main>
  <header>
    <p class="eyebrow">funkpost · Termine</p>
    <h1>{state?.shop?.name ?? DEFAULT_SHOP.name}</h1>
    <p class="tag">Terminbuchung über ein LoRa-Mesh — ohne Server, ohne Internet</p>
  </header>

  {#if !role}
    <section class="card pick">
      <h2>Wer bist du?</h2>
      <div class="row">
        <button class="btn" onclick={() => chooseRole("salon")}>Ich bin der Salon</button>
        <button class="btn ghost" onclick={() => chooseRole("customer")}>Ich möchte einen Termin</button>
      </div>
      <p class="dim">
        Der Salon führt das Buch und entscheidet. Beide Seiten sprechen nur über Funk.
      </p>
    </section>
  {:else if phase !== "ready"}
    <section class="card">
      <h2>Funk</h2>
      {#if phase === "connecting"}
        <p>verbinde…</p>
      {:else}
        <button class="btn" onclick={connect}>Knoten verbinden</button>
        <p class="dim">
          Öffnet die Bluetooth-Auswahl des Browsers. Mit <code>?mesh=bc</code> spielen
          zwei Tabs die zwei Geräte, ganz ohne Hardware.
        </p>
      {/if}
      {#if error}<p class="error">{error}</p>{/if}
    </section>
  {:else if !state}
    <section class="card"><p class="dim">Termine werden geladen…</p></section>
  {:else if role === "customer"}
    <!-- ───────────── Kunde ───────────── -->
    <section class="card booking" data-testid="customer">
      <aside>
        <p class="eyebrow">Termin buchen bei</p>
        <p class="salon">{state.shop.name}</p>
        <label class="field">
          <span>Leistung</span>
          <select bind:value={serviceId} data-testid="service">
            {#each state.shop.services as service (service.id)}
              <option value={service.id}>{service.label} · {service.minutes} min</option>
            {/each}
          </select>
        </label>
        <label class="field">
          <span>Dein Vorname</span>
          <input bind:value={handle} placeholder="Anna" data-testid="handle" />
        </label>
        <p class="note">
          <strong>Nur Vorname und Leistung reisen.</strong> Auf einem öffentlichen
          Kanal hören Nachbarknoten mit — alles Weitere bleibt auf diesem Gerät.
        </p>
        <p class="dim">
          {state.shop.mode === "auto"
            ? "Freie Zeiten werden sofort bestätigt."
            : "Der Salon bestätigt jede Anfrage einzeln."}
        </p>
      </aside>

      <div>
        <div class="days">
          {#each openDays as entry (entry.iso)}
            <button
              class="day"
              aria-pressed={day === entry.iso}
              disabled={entry.free === 0}
              onclick={() => {
                day = entry.iso;
                slotIndex = null;
              }}
            >
              <span>{dayLabel(entry.iso).weekday}</span>
              <b>{dayLabel(entry.iso).day}</b>
            </button>
          {/each}
        </div>

        <div class="slots" data-testid="slots">
          {#each slotsForDay as slot (slot.index)}
            <button
              class="slot"
              disabled={!slot.free}
              aria-pressed={slotIndex === slot.index}
              data-slot={timeOf(slot)}
              onclick={() => (slotIndex = slot.index)}
            >
              {timeOf(slot)}
            </button>
          {/each}
          {#if slotsForDay.length === 0}<p class="dim">An diesem Tag ist zu.</p>{/if}
        </div>

        <div class="row cta">
          <button
            class="btn"
            disabled={slotIndex == null || !handle.trim() || busyAction}
            onclick={book}
            data-testid="book"
          >
            {state.shop.mode === "auto" ? "Termin buchen" : "Termin anfragen"}
          </button>
        </div>
      </div>
    </section>

    {#if arriving && myBookings.length === 0}
      <section class="card" data-testid="awaiting-link">
        <h2>Termin wird gesucht</h2>
        <p class="dim">
          Der Link hat den Termin mitgebracht — er wird jetzt über Funk geholt.
          Diese Seite kam von einem Webserver; alles Weitere läuft über das Mesh.
        </p>
      </section>
    {/if}

    {#if myBookings.length > 0}
      <section class="card" data-testid="my-bookings">
        <h2>Deine Termine</h2>
        {#each myBookings as entry (entry.id)}
          <div class="mine" data-testid="booking" data-status={entry.status}>
            <div>
              <p class="when">
                {dayLabel(state.grid[entry.slotIndex].iso).weekday},
                {timeOf(state.grid[entry.slotIndex])} Uhr ·
                {serviceById(state.shop, entry.serviceId)?.label}
              </p>
              <p class="dim">
                <span class="pill {entry.status}">{STATUS_TEXT[entry.status] ?? entry.status}</span>
                {#if entry.reason}<span> — {entry.reason}</span>{/if}
              </p>
            </div>
            <div class="row">
              {#if entry.status === CONFIRMED}
                <button class="btn sm" onclick={() => saveIcs(tokenOf(entry.id))} data-testid="save-ics">
                  Termin.ics
                </button>
              {/if}
              {#if entry.status === CONFIRMED || entry.status === PENDING}
                <button class="btn ghost sm" onclick={() => cancel(tokenOf(entry.id))}>Absagen</button>
              {/if}
            </div>
          </div>
          {#if entry.status === CONFIRMED}
            <p class="link" data-testid="change-link">{linkFor(tokenOf(entry.id))}</p>
          {/if}
        {/each}
      </section>
    {/if}
  {:else}
    <!-- ───────────── Salon ───────────── -->
    <section class="card" data-testid="salon">
      <div class="row spread">
        <h2>Tagesplan</h2>
        <div class="switch">
          <button
            aria-pressed={state.shop.mode === "auto"}
            onclick={() => live.book.setShop({ mode: "auto" })}
            data-testid="mode-auto">Autobestätigung</button
          >
          <button
            aria-pressed={state.shop.mode === "ask"}
            onclick={() => live.book.setShop({ mode: "ask" })}
            data-testid="mode-ask">Rückfrage</button
          >
        </div>
      </div>

      <div class="days">
        {#each openDays as entry (entry.iso)}
          <button class="day" aria-pressed={day === entry.iso} onclick={() => (day = entry.iso)}>
            <span>{dayLabel(entry.iso).weekday}</span>
            <b>{dayLabel(entry.iso).day}</b>
          </button>
        {/each}
      </div>

      {#if pending.length > 0}
        <div class="popup" data-testid="pending">
          <p class="eyebrow">Neue Anfrage über Funk</p>
          {#each pending as entry (entry.id)}
            <div class="ask">
              <p class="when">
                <strong>{entry.handle}</strong> möchte
                {dayLabel(state.grid[entry.slotIndex].iso).weekday},
                {timeOf(state.grid[entry.slotIndex])} Uhr ·
                {serviceById(state.shop, entry.serviceId)?.label}
              </p>
              <div class="row">
                <button class="btn ok sm" disabled={busyAction} onclick={() => decide(entry.id, CONFIRMED)} data-testid="confirm">
                  Bestätigen
                </button>
                <button class="btn ghost sm" disabled={busyAction} onclick={() => decide(entry.id, DECLINED)} data-testid="decline">
                  Ablehnen
                </button>
              </div>
            </div>
          {/each}
        </div>
      {/if}

      <div class="agenda">
        {#each agenda as entry (entry.slot.index)}
          <div class="slotrow" class:taken={entry.booking}>
            <span class="t">{timeOf(entry.slot)}</span>
            {#if entry.booking}
              <span class="who">{entry.booking.handle}</span>
              <span class="pill {entry.booking.status}">{STATUS_TEXT[entry.booking.status]}</span>
            {:else}
              <span class="who dim">frei</span>
            {/if}
          </div>
        {/each}
      </div>
    </section>
  {/if}

  {#if phase === "ready"}
    <section class="radio">
      <button class="radio-head" onclick={() => (showRadio = !showRadio)}>
        <span class="title">Funkstreifen</span>
        <span>Frames {totals.framesTx}→ ←{totals.framesRx}</span>
        <span>Runden {totals.retransmitRounds}</span>
        <span>Sendungen {syncStats.payloadsSent}→ ←{syncStats.payloadsReceived}</span>
        <span class="chev">{showRadio ? "▾" : "▸"}</span>
      </button>
      {#if showRadio}
        <div class="radio-log">
          {#each log as line (line.id)}
            <div><span class="ts">{line.ts}</span> {line.text}</div>
          {/each}
          {#if log.length === 0}<div class="ts">still.</div>{/if}
        </div>
      {/if}
    </section>
  {/if}

  {#if error}<p class="error">{error}</p>{/if}

  <footer>
    <a href="https://github.com/NiKrause/funkpost/issues/38">Entwurf #38</a> · GPL-3.0 ·
    <span class="build">{build.version} · {build.commit} · {build.builtAt}</span>
  </footer>
</main>

<style>
  :global(body) {
    margin: 0;
    background: #f4f6f9;
    color: #14171f;
    font-family: "Public Sans", system-ui, sans-serif;
    line-height: 1.55;
  }
  main {
    max-width: 880px;
    margin: 0 auto;
    padding: 28px 18px 64px;
    display: flex;
    flex-direction: column;
    gap: 18px;
  }
  h1 { margin: 2px 0 0; font-size: 1.7rem; letter-spacing: -0.015em; }
  h2 { margin: 0 0 12px; font-size: 1.05rem; }
  .eyebrow {
    margin: 0; font-family: "IBM Plex Mono", monospace; font-size: 0.72rem;
    letter-spacing: 0.13em; text-transform: uppercase; color: #8b93a5;
  }
  .tag { margin: 4px 0 0; color: #5b6478; font-size: 0.92rem; }
  .dim { color: #5b6478; font-size: 0.86rem; margin: 0; }
  .error { color: #b3261e; font-size: 0.9rem; }

  .card {
    background: #fff; border: 1px solid #e3e7ee; border-radius: 12px;
    padding: 18px 20px;
    box-shadow: 0 1px 2px rgba(20, 23, 31, 0.05);
  }
  .row { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }
  .row.spread { justify-content: space-between; }
  .cta { margin-top: 16px; }
  .pick .row { margin: 8px 0 12px; }

  .booking { display: grid; grid-template-columns: 250px 1fr; gap: 0; padding: 0; }
  .booking > aside {
    padding: 20px; border-right: 1px solid #e3e7ee; background: #fafbfd;
    border-radius: 12px 0 0 12px;
  }
  .booking > div { padding: 20px; }
  @media (max-width: 700px) {
    .booking { grid-template-columns: 1fr; }
    .booking > aside { border-right: 0; border-bottom: 1px solid #e3e7ee; border-radius: 12px 12px 0 0; }
  }
  .salon { margin: 2px 0 14px; font-size: 1.15rem; font-weight: 700; }
  .field { display: flex; flex-direction: column; gap: 4px; margin-bottom: 12px; font-size: 0.84rem; color: #5b6478; }
  .field select, .field input {
    padding: 7px 9px; border: 1px solid #d5dae4; border-radius: 8px;
    font: inherit; font-size: 0.92rem; color: #14171f; background: #fff;
  }
  .note {
    margin: 14px 0 10px; padding: 10px 11px; border: 1px solid #c3ceff;
    background: #eaeeff; border-radius: 9px; font-size: 0.78rem; color: #5b6478;
  }

  .days { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 14px; }
  .day {
    border: 1px solid #e3e7ee; background: #fff; border-radius: 9px;
    padding: 6px 10px; cursor: pointer; font: inherit; text-align: center; line-height: 1.2;
  }
  .day span { display: block; font-size: 0.66rem; text-transform: uppercase; color: #8b93a5; letter-spacing: 0.06em; }
  .day b { font-size: 0.98rem; font-variant-numeric: tabular-nums; }
  .day[aria-pressed="true"] { border-color: #2d4ad0; background: #eaeeff; }
  .day[aria-pressed="true"] b { color: #2d4ad0; }
  .day:disabled { opacity: 0.35; cursor: not-allowed; }

  .slots { display: grid; grid-template-columns: repeat(auto-fill, minmax(84px, 1fr)); gap: 7px; }
  .slot {
    border: 1px solid #c3ceff; background: #fff; color: #2d4ad0;
    border-radius: 8px; padding: 8px 4px; cursor: pointer;
    font: inherit; font-weight: 600; font-variant-numeric: tabular-nums; font-size: 0.88rem;
  }
  .slot:hover:not(:disabled) { background: #eaeeff; }
  .slot[aria-pressed="true"] { background: #2d4ad0; color: #fff; border-color: #2d4ad0; }
  .slot:disabled {
    border-color: #e3e7ee; color: #8b93a5; background: #eef1f6;
    cursor: not-allowed; text-decoration: line-through; font-weight: 400;
  }

  .btn {
    border: 1px solid #2d4ad0; background: #2d4ad0; color: #fff;
    padding: 9px 18px; border-radius: 9px; font: inherit; font-weight: 600; cursor: pointer;
  }
  .btn:disabled { opacity: 0.4; cursor: not-allowed; }
  .btn.ghost { background: transparent; color: #2d4ad0; }
  .btn.ok { background: #12855a; border-color: #12855a; }
  .btn.sm { padding: 6px 12px; font-size: 0.85rem; }

  .switch { display: flex; border: 1px solid #e3e7ee; border-radius: 8px; overflow: hidden; }
  .switch button { border: 0; background: #fff; color: #5b6478; font: inherit; font-size: 0.82rem; padding: 6px 11px; cursor: pointer; }
  .switch button[aria-pressed="true"] { background: #2d4ad0; color: #fff; font-weight: 600; }

  .mine { display: flex; flex-wrap: wrap; gap: 10px; justify-content: space-between; align-items: center; padding: 10px 0; border-top: 1px solid #eef1f6; }
  .when { margin: 0; font-size: 0.95rem; font-weight: 600; }
  .link { font-family: "IBM Plex Mono", monospace; font-size: 0.68rem; color: #5b6478; word-break: break-all; margin: 0 0 8px; }

  .pill { display: inline-block; font-size: 0.72rem; font-weight: 600; padding: 2px 8px; border-radius: 999px; background: #eef1f6; color: #5b6478; }
  .pill.confirmed { background: #e4f4ec; color: #12855a; }
  .pill.pending { background: #fbf0dd; color: #a86412; }
  .pill.declined, .pill.superseded, .pill.cancelled { background: #fbe4e2; color: #b3261e; }

  .popup { border: 1px solid #a86412; background: #fbf0dd; border-radius: 10px; padding: 14px 15px; margin: 12px 0; }
  .ask { display: flex; flex-wrap: wrap; gap: 10px; justify-content: space-between; align-items: center; }

  .agenda { display: flex; flex-direction: column; gap: 4px; margin-top: 12px; }
  .slotrow {
    display: grid; grid-template-columns: 62px 1fr auto; gap: 10px; align-items: center;
    padding: 8px 11px; border: 1px dashed #e3e7ee; border-radius: 8px; background: #fafbfd;
  }
  .slotrow.taken { border-style: solid; background: #fff; }
  .slotrow .t { font-family: "IBM Plex Mono", monospace; font-size: 0.8rem; color: #5b6478; font-variant-numeric: tabular-nums; }
  .slotrow .who { font-size: 0.9rem; font-weight: 600; }
  .slotrow .who.dim { font-weight: 400; }

  .radio { background: #0b0e15; border-radius: 12px; overflow: hidden; font-family: "IBM Plex Mono", monospace; }
  .radio-head {
    width: 100%; display: flex; flex-wrap: wrap; gap: 8px 16px; align-items: center;
    padding: 9px 14px; background: transparent; border: 0; cursor: pointer;
    color: #9aa3b5; font: inherit; font-size: 0.72rem; text-align: left;
  }
  .radio-head .title { color: #e8eaf0; margin-right: auto; }
  .radio-head .chev { color: #5dd39e; }
  .radio-log { padding: 6px 14px 12px; font-size: 0.72rem; line-height: 1.7; color: #e8eaf0; max-height: 180px; overflow-y: auto; display: flex; flex-direction: column-reverse; }
  .radio-log .ts { color: #9aa3b5; }

  footer { color: #8b93a5; font-size: 0.8rem; }
  footer a { color: #2d4ad0; }
  .build { font-family: "IBM Plex Mono", monospace; font-size: 0.7rem; }
</style>
