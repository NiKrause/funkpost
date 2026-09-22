<!-- SPDX-License-Identifier: GPL-3.0-only -->
<script>
  /**
   * Two roles on one page: the salon keeps the book, a customer takes a slot.
   * Every byte between them crosses a LoRa mesh — the radio strip at the
   * bottom prices it, because a demo that hides the transport is lying about
   * what it is.
   */
  import { onMount } from "svelte";
  import { creditHTML, lang } from "@le-space/funkpost-brand";
  import { WORDS } from "./words.js";
  import {
    createStack,
    connectCourier,
    todayISO,
    downloadFile,
  } from "./stack.js";
  import { preferredChannelIndex, DEFAULT_PREFERRED_CHANNEL } from "@le-space/funkpost";
  import { DEFAULT_SHOP, serviceById } from "./domain/slots.js";
import { wallAt } from "./domain/time.js";
  import { CONFIRMED, PENDING, DECLINED, CANCELLED, SUPERSEDED } from "./domain/arbitration.js";
  import { toBase64Url, fromBase64Url } from "./domain/capability.js";
  import { bookingLink, parseBookingLink } from "./domain/link.js";

  const build = __BUILD_INFO__;
  // The page's words in its current language; a log line keeps the language it
  // was written in.
  const t = $derived(WORDS[$lang]);
  const w = () => WORDS[lang.get()];
  $effect(() => {
    document.title = t.title;
  });
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
  // Storage namespace — IndexedDB and localStorage, never the radio.
  //
  // Over Bluetooth this was fixed at "ble", which meant two windows on one
  // machine shared one book: the salon's calendar reached the customer through
  // the *database*, with no packet involved, and a bench test could pass while
  // the mesh carried nothing. `?room=` separates them, so one laptop with two
  // nodes can play both sides honestly.
  const room = mode.kind === "bc" ? mode.room : (params.get("room") ?? "ble");

  // Der Hinweis gilt pro Browser, nicht pro Raum — er handelt vom Projekt,
  // nicht von einem Kalender. Verweigert der Browser den Speicher, erscheint er
  // jedes Mal wieder: die richtige Richtung, in die eine Warnung ausfallen darf.
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
      /* nur für diesen Besuch weggeklickt */
    }
  };
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
  // Frames the radio stopped retransmitting. Not a failure — the ARQ still
  // recovers — but each one spent its retries on air, which is what #73 asks
  // the size of. Shown only when it happens: a permanent zero is noise.
  let refusals = $state({ soft: 0, last: null });
  let syncStats = $state({ payloadsSent: 0, payloadsReceived: 0 });
  let presence = $state({ peers: [], lastHeardAgoMs: null });

  // Airtime is rationed by law and the node enforces it. When there is none
  // left, the honest thing is to stop offering actions that cannot happen —
  // and to say when they can, rather than letting a booking fail silently.
  let blockedForMs = $state(0);
  let budget = $state(null);

  /** The regional share, from the courier rather than a constant: EU 868 allows
   *  10 % of an hour, EU 866 only 2.5 %, and stating the wrong one is stating a
   *  legal limit wrongly. */
  const dutyCycleText = $derived(
    budget?.dutyCycle == null ? "" : t.perHour((budget.dutyCycle * 100).toFixed(budget.dutyCycle < 0.05 ? 1 : 0)),
  );
  const airtimeBlocked = $derived(blockedForMs > 0);

  const untilFree = $derived.by(() => {
    if (blockedForMs <= 0) return "";
    const minutes = Math.ceil(blockedForMs / 60_000);
    if (minutes <= 1) return t.underAMinute;
    return t.inMinutes(minutes);
  });

  // Which channel we TRANSMIT on. Reception decodes every channel the node
  // holds a key for, so a mismatch is silent: both sides hear each other's
  // packets and decrypt none of them. The fingerprint is the first two bytes
  // of the key's SHA-256 — enough for two people to compare across a room.
  let channels = $state([]);
  let primaryChannel = $state(null);
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
      name: channel.settings?.name || w().defaultChannel,
      fingerprint: [...digest.slice(0, 2)].map((b) => b.toString(16).padStart(2, "0")).join(""),
    };
    channelMap.set(entry.index, entry);
    channels = [...channelMap.values()].sort((a, b) => a.index - b.index);
    if (entry.role === 1) primaryChannel = { name: entry.name, fingerprint: entry.fingerprint };
    pushLog(w().log.channel(entry.index, entry.name, entry.fingerprint, entry.role === 1));
    // Channels arrive one at a time and the wanted one need not be first.
    // Before the connection resolves this is a no-op, so the call after it is
    // the one that lands in the common case.
    applyPreferredChannel();
  }

  // What the node hears, before it decides whether it can read it. A packet on
  // a channel whose key this node does not hold is dropped inside the client
  // library with only a debug line — so "nobody is there" and "somebody is
  // there and we cannot read a word" look identical without this.
  let heard = $state({ total: 0, undecryptable: 0 });

  // Phones sleep their screen, and Web Bluetooth pauses with it — the quiet
  // killer of a bench session. Desktops do not take the radio down with them,
  // so the box only appears on handhelds. The detection deliberately does not
  // trust `userAgentData.mobile` alone: an unfolded Samsung Fold reports false
  // while still being a battery device that sleeps under you.
  const isHandheld =
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
    if (keepAwake) await acquireWakeLock();
    else {
      await wakeSentinel?.release();
      wakeSentinel = null;
      pushLog(w().log.wakeOff);
    }
  }

  const reacquireOnReturn = () => {
    if (keepAwake && document.visibilityState === "visible" && !wakeSentinel) acquireWakeLock();
  };

  /** Grey: no radio. Amber: radio up, nobody heard. Green: somebody is there. */
  const linkState = $derived.by(() => {
    if (phase !== "ready") return { level: "off", text: t.link.off };
    const ago = presence.lastHeardAgoMs;
    if (ago == null) return { level: "waiting", text: t.link.waiting };
    if (ago > 120_000) return { level: "waiting", text: t.link.lastHeard(Math.round(ago / 60000)) };
    const n = presence.peers.length;
    return {
      level: "live",
      text: n === 0 ? t.link.answers : t.link.inRange(n),
    };
  });

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

  let stack = null;

  const refresh = async () => {
    if (!live) return;
    state = await live.book.state(fromISO, DEFAULT_SHOP.horizonDays);
    if (!day && state.grid.length > 0) day = state.grid[0].iso;
    if (live.courier?.stats) totals = { ...live.courier.stats };
    if (live.refusals) refusals = { ...live.refusals };
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

  /**
   * A booking's own time, read from the instant it stored. Deliberately NOT
   * looked up in the grid: a booking that today's grid does not happen to
   * contain must still be shown, not silently omitted.
   */
  const whenOf = (booking) => {
    const wall = wallAt(booking.startMs, state?.shop?.tz ?? DEFAULT_SHOP.tz);
    const weekday = t.weekdays[new Date(Date.UTC(wall.year, wall.month - 1, wall.day)).getUTCDay()];
    return t.when(weekday, wall);
  };

  const dayLabel = (iso) => {
    const [y, m, d] = iso.split("-").map(Number);
    const at = new Date(Date.UTC(y, m - 1, d));
    return {
      weekday: t.weekdays[at.getUTCDay()],
      day: d,
    };
  };

  const STATUS_TEXT = $derived({
    [CONFIRMED]: t.status.confirmed,
    [PENDING]: t.status.pending,
    [DECLINED]: t.status.declined,
    [CANCELLED]: t.status.cancelled,
    [SUPERSEDED]: t.status.superseded,
  });

  onMount(async () => {
    loadMine();
    // Put back what this device already knew, before touching the radio: a
    // reload should not cost airtime asking for a book we already have.
    stack = await createStack({
      room,
      pinnedToday,
      onError: (e) => pushLog(w().log.storage(e?.message ?? e)),
    });
    if (stack.restored > 0) pushLog(w().log.restored(stack.restored));
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
      if (live?.refusals) refusals = { ...live.refusals };
      if (live?.sync?.stats) syncStats = { ...live.sync.stats };
      if (live?.sync?.presence) presence = live.sync.presence();
      // One frame is what any single action costs — a booking, a decision, a
      // cancellation are all one record.
      if (live?.courier?.timeUntilAffordable) {
        blockedForMs = live.courier.timeUntilAffordable();
        budget = live.courier.budget();
      }
    }, 1000);
    document.addEventListener("visibilitychange", reacquireOnReturn);
    return () => {
      clearInterval(ticker);
      document.removeEventListener("visibilitychange", reacquireOnReturn);
    };
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
          if (event.kind === "duty-cycle-exhausted")
            pushLog(w().log.airtimeSpent);
          if (event.kind === "giveup") pushLog(w().log.gaveUp(event.msgId, event.rounds));
          if (event.kind === "accepted") pushLog(w().log.accepted(event.id));
          if (event.kind === "rejected") pushLog(w().log.rejected);
          if (event.kind === "sent" && event.tag === 0x10) pushLog(w().log.digest(event.bytes));
          if (event.kind === "sent" && event.tag === 0x12) pushLog(w().log.booking(event.bytes));
          if (event.kind === "error") {
            const text = event.error?.message ?? String(event.error);
            // The node reports its region a second after connecting; until then
            // the courier refuses to transmit because it does not know the
            // local airtime law. Expected, brief, and not the user's problem —
            // it reads as a fault only because it was worded as one.
            pushLog(
              /region is UNSET/i.test(text)
                ? w().log.regionUnset
                : `! ${text}`,
            );
          }
        },
        onChange: () => refresh(),
        onRegion: (name) => {
          region = name;
          pushLog(w().log.region(name));
        },
        onStatus: (name) => pushLog(w().log.nodeStatus(name)),
        onChannel: handleChannel,
        onTraffic: (packet) => {
          heard = {
            total: heard.total + 1,
            undecryptable:
              heard.undecryptable + (packet?.payloadVariant?.case === "encrypted" ? 1 : 0),
          };
        },
        onMyNodeInfo: (info) => {
          if (info?.myNodeNum) myNode = `!${info.myNodeNum.toString(16).padStart(8, "0")}`;
        },
        onError: (message) => pushLog(`! ${message}`),
        onReconnecting: (n) => pushLog(w().log.reconnecting(n)),
        onReconnected: (how) =>
          pushLog(how === "reattached" ? w().log.reattached : w().log.reconnected),
        onGaveUp: () => {
          error = w().gaveUp;
        },
      });
      linkKind = live.kind;
      region = live.region;
      // Deliberate test seam: the e2e suite has no radio to exhaust, so it
      // drives the node's own airtime figure the way a real node would report
      // it. Reading the courier is the only way to observe that path end to end.
      window.__courier = live.courier;
      // Same seam, same reason: the suite has no radio to report its channels,
      // and channel selection is a path that fails *silently* when it is
      // wrong — so it is worth exercising rather than reasoning about.
      window.__nodeChannel = handleChannel;
      setTxChannelFn = live.setTxChannel ?? (() => {});
      // Now that the switch actually does something, act on whatever the node
      // already told us while it was still connecting.
      applyPreferredChannel();

      if (role === "salon") {
        const saved = localStorage.getItem(`salon:${room}`);
        try {
          salonToken = saved
            ? await live.book.becomeSalon(fromBase64Url(saved))
            : await live.book.becomeSalon();
          localStorage.setItem(`salon:${room}`, toBase64Url(salonToken));
          pushLog(w().log.salonPublished);
        } catch (e) {
          // Another device already holds this shop. Say so plainly rather than
          // taking it over and silently voiding that device's decisions.
          error = w().salonTaken;
          pushLog(`! ${e.message}`);
        }
      }

      // A booking may arrive at any moment; the Yjs rules likewise.
      stack.doc.on("update", () => refresh());
      // Compute the view BEFORE announcing readiness: the template reads
      // state.shop directly, and a single tick of `ready` with a null state
      // is a crash rather than a flicker.
      await refresh();
      phase = "ready";
      pushLog(w().log.radioOpen(w().linkKinds[linkKind] ?? linkKind));
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
      pushLog(w().log.requested);
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
      pushLog(status === CONFIRMED ? w().log.confirmed : w().log.declined);
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
      pushLog(w().log.cancelled);
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
    pushLog(w().log.saved(file.filename));
  }

  const linkFor = (entry) =>
    bookingLink({ shopId: SHOP_ID, bookingId: entry.id, token: fromBase64Url(entry.token) });

  const tokenOf = (id) => mine.find((m) => m.id === id) ?? null;
</script>

<main>
  <header>
    <p class="eyebrow">{t.eyebrow}</p>
    <h1>{state?.shop?.name ?? DEFAULT_SHOP.name}</h1>
    <p class="tag">{t.tag}</p>
  </header>

  <!-- Kurz, und einmal weggeklickt bleibt es weg. Die Messaussage aus
       mesh-todo steht hier bewusst nicht: diese Ebene trägt Regeln und
       kleine signierte Einträge, nicht ganze Blöcke. -->
  {#if showNotice}
    <aside class="notice" data-testid="experimental-notice">
      {#if $lang === "de"}
        <p>
          <strong>Experimentell.</strong> Ein Forschungs-Demonstrator, nicht
          auditiert, nicht für den Produktivbetrieb — wer den Funkkanal hört,
          kann Termine anlegen.
        </p>
      {:else}
        <p>
          <strong>Experimental.</strong> A research demonstrator, not audited,
          not for production — anyone who can hear the radio channel can create
          appointments.
        </p>
      {/if}
      <button class="dismiss" onclick={dismissNotice} data-testid="dismiss-notice">
        {t.dismiss}
      </button>
    </aside>
  {/if}

  {#if phase === "ready"}
    <p class="link-state" data-testid="link-state" data-level={linkState.level}>
      <span class="led {linkState.level}"></span>
      {linkState.text}
      {#if region && region !== "UNSET"}<span class="dim"> · {region}</span>{/if}
    </p>
    {#if airtimeBlocked}
      <p class="airtime" data-testid="airtime-blocked">
        {#if $lang === "de"}
          <strong>Sendezeit aufgebraucht.</strong>
          Dieser Knoten hat sein gesetzliches Stundenkontingent ausgeschöpft{#if dutyCycleText}
            {" "}({region} · {dutyCycleText}){/if} und sendet nichts mehr. Empfangen
          geht weiter — nur Buchen, Bestätigen und Absagen pausieren. Wieder
          möglich <strong>{untilFree}</strong>.
        {:else}
          <strong>Airtime spent.</strong>
          This node has used its legal hourly allowance{#if dutyCycleText}
            {" "}({region} · {dutyCycleText}){/if} and will not transmit. Receiving
          continues — only booking, confirming and cancelling pause. Possible
          again <strong>{untilFree}</strong>.
        {/if}
      </p>
    {/if}

    {#if heard.undecryptable > 0 && presence.peers.length === 0}
      <p class="mismatch" data-testid="key-mismatch">
        {#if $lang === "de"}
          <strong>{heard.undecryptable} von {heard.total} Paketen sind nicht lesbar.</strong>
          Der Knoten hört etwas, kann es aber nicht entschlüsseln — die Gegenstelle
          sendet auf einem Kanal, dessen Schlüssel dieser Knoten nicht hat.
          Vergleicht den Fingerabdruck ⌗ unten auf beiden Geräten.
        {:else}
          <strong>{heard.undecryptable} of {heard.total} packets cannot be read.</strong>
          The node hears something but cannot decrypt it — the other side
          transmits on a channel whose key this node does not hold. Compare the
          fingerprint ⌗ below on both devices.
        {/if}
      </p>
    {/if}

    {#if channels.length > 0}
      <p class="channel" data-testid="channel">
        <label title={t.txChannelTitle}>
          {t.txChannel}
          <select
            bind:value={txChannel}
            onchange={() => {
              // A hand-made choice is final: nothing may move the selector
              // afterwards, or a late-arriving channel would silently undo it.
              txChannelChosenByHand = true;
              setTxChannelFn(txChannel);
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
        {#if myNode}<span class="dim"> · {t.thisNode} {myNode}</span>{/if}
      </p>
    {/if}

    {#if wakeLockSupported && isHandheld}
      <label class="awake dim">
        <input type="checkbox" bind:checked={keepAwake} onchange={toggleAwake} data-testid="wake-lock" />
        {t.keepAwake}
      </label>
    {/if}
  {/if}

  {#if !role}
    <section class="card pick">
      <h2>{t.whoAreYou}</h2>
      <div class="row">
        <button class="btn" onclick={() => chooseRole("salon")}>{t.iAmSalon}</button>
        <button class="btn ghost" onclick={() => chooseRole("customer")}>{t.iWantAppointment}</button>
      </div>
      <p class="dim">{t.rolesHint}</p>
    </section>
  {:else if phase !== "ready"}
    <section class="card">
      <h2>{t.radio}</h2>
      {#if phase === "connecting"}
        <p>{t.connecting}</p>
      {:else}
        <button class="btn" onclick={connect}>{t.connect}</button>
        {#if $lang === "de"}
          <p class="dim">
            Öffnet die Bluetooth-Auswahl des Browsers. Mit <code>?mesh=bc</code> spielen
            zwei Tabs die zwei Geräte, ganz ohne Hardware.
          </p>
        {:else}
          <p class="dim">
            Opens the browser's Bluetooth chooser. With <code>?mesh=bc</code>, two tabs
            play the two devices, with no hardware at all.
          </p>
        {/if}
      {/if}
      {#if error}<p class="error">{error}</p>{/if}
    </section>
  {:else if !state}
    <section class="card"><p class="dim">{t.loading}</p></section>
  {:else if role === "customer"}
    <!-- ───────────── Kunde ───────────── -->
    <section class="card booking" data-testid="customer">
      <aside>
        <p class="eyebrow">{t.bookWith}</p>
        <p class="salon">{state.shop.name}</p>
        <label class="field">
          <span>{t.service}</span>
          <select bind:value={serviceId} data-testid="service">
            {#each state.shop.services as service (service.id)}
              <option value={service.id}>{service.label} · {service.minutes} min</option>
            {/each}
          </select>
        </label>
        <label class="field">
          <span>{t.firstName}</span>
          <input bind:value={handle} placeholder="Anna" data-testid="handle" />
        </label>
        {#if $lang === "de"}
          <p class="note">
            <strong>Nur Vorname und Leistung reisen.</strong> Auf einem öffentlichen
            Kanal hören Nachbarknoten mit — alles Weitere bleibt auf diesem Gerät.
          </p>
        {:else}
          <p class="note">
            <strong>Only the first name and the service travel.</strong> On a public
            channel neighbouring nodes listen in — everything else stays on this device.
          </p>
        {/if}
        <p class="dim">
          {state.shop.mode === "auto" ? t.autoConfirms : t.salonConfirms}
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
          {#if slotsForDay.length === 0}<p class="dim">{t.closed}</p>{/if}
        </div>

        <div class="row cta">
          <button
            class="btn"
            disabled={slotIndex == null || !handle.trim() || busyAction || airtimeBlocked}
            onclick={book}
            data-testid="book"
          >
            {airtimeBlocked ? t.airtimeSpent : state.shop.mode === "auto" ? t.book : t.request}
          </button>
        </div>
      </div>
    </section>

    {#if arriving && myBookings.length === 0}
      <section class="card" data-testid="awaiting-link">
        <h2>{t.searching}</h2>
        <p class="dim">{t.searchingHint}</p>
      </section>
    {/if}

    {#if myBookings.length > 0}
      <section class="card" data-testid="my-bookings">
        <h2>{t.yourAppointments}</h2>
        {#each myBookings as entry (entry.id)}
          <div class="mine" data-testid="booking" data-status={entry.status}>
            <div>
              <p class="when">
                {whenOf(entry)} · {serviceById(state.shop, entry.serviceId)?.label}
              </p>
              <p class="dim">
                <span class="pill {entry.status}">{STATUS_TEXT[entry.status] ?? entry.status}</span>
                {#if entry.reason}<span> — {entry.reason}</span>{/if}
              </p>
            </div>
            <div class="row">
              {#if entry.status === CONFIRMED}
                <button class="btn sm" onclick={() => saveIcs(tokenOf(entry.id))} data-testid="save-ics">
                  {t.ics}
                </button>
              {/if}
              {#if entry.status === CONFIRMED || entry.status === PENDING}
                <button class="btn ghost sm" disabled={airtimeBlocked} onclick={() => cancel(tokenOf(entry.id))}>{t.cancel}</button>
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
        <h2>{t.dayPlan}</h2>
        <div class="switch">
          <button
            aria-pressed={state.shop.mode === "auto"}
            onclick={() => live.book.setShop({ mode: "auto" })}
            data-testid="mode-auto">{t.autoConfirm}</button
          >
          <button
            aria-pressed={state.shop.mode === "ask"}
            onclick={() => live.book.setShop({ mode: "ask" })}
            data-testid="mode-ask">{t.askFirst}</button
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
          <p class="eyebrow">{t.newRequest}</p>
          {#each pending as entry (entry.id)}
            <div class="ask">
              <p class="when">
                <strong>{entry.handle}</strong> {t.wouldLike} {whenOf(entry)} ·
                {serviceById(state.shop, entry.serviceId)?.label}
              </p>
              <div class="row">
                <button class="btn ok sm" disabled={busyAction || airtimeBlocked} onclick={() => decide(entry.id, CONFIRMED)} data-testid="confirm">
                  {t.confirm}
                </button>
                <button class="btn ghost sm" disabled={busyAction || airtimeBlocked} onclick={() => decide(entry.id, DECLINED)} data-testid="decline">
                  {t.decline}
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
              <span class="who dim">{t.free}</span>
            {/if}
          </div>
        {/each}
      </div>
    </section>
  {/if}

  {#if phase === "ready"}
    <section class="radio">
      <button class="radio-head" onclick={() => (showRadio = !showRadio)}>
        <span class="title">{t.radioStrip}</span>
        <span>Frames {totals.framesTx}→ ←{totals.framesRx}</span>
        <span>{t.rounds} {totals.retransmitRounds}</span>
        {#if refusals.soft > 0}<span title={t.givenUpTitle(refusals.last)}>{t.givenUp} {refusals.soft}</span>{/if}
        <span>{t.payloads} {syncStats.payloadsSent}→ ←{syncStats.payloadsReceived}</span>
        <span class="chev">{showRadio ? "▾" : "▸"}</span>
      </button>
      {#if showRadio}
        <div class="radio-log">
          {#each log as line (line.id)}
            <div><span class="ts">{line.ts}</span> {line.text}</div>
          {/each}
          {#if log.length === 0}<div class="ts">{t.quiet}</div>{/if}
        </div>
      {/if}
    </section>
  {/if}

  {#if error}<p class="error">{error}</p>{/if}

  <footer>
    <a href="https://github.com/NiKrause/funkpost">{t.source}</a> ·
    <a href="https://github.com/NiKrause/funkpost/issues/38">{t.design}</a> · GPL-3.0 ·
    <span class="build">
      {build.version} ·
      <!-- The build already knew which commit it is; now it can be opened. A
           version string nobody can look up is decoration. -->
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
    line-height: 1.55;
  }
  /* 64 px on top: the Le Space pill sits in the first 56.
     The page's own colours, each drawn from the brand's tokens, so the light
     book and the dark one are one set of rules. */
  main {
    --card: var(--ls-bg-2);
    --ground-2: color-mix(in srgb, var(--ls-bg-2) 55%, var(--ls-bg-0));
    --line: var(--ls-bg-3);
    --ink: var(--ls-text);
    --ink-2: var(--ls-text-dim);
    /* small labels: dimmer than running text, still AA */
    --ink-3: color-mix(in srgb, var(--ls-text-dim) 80%, var(--ls-bg-0));
    --accent: var(--ls-accent);
    --accent-soft: color-mix(in srgb, var(--ls-accent) 12%, var(--ls-bg-2));
    --accent-line: color-mix(in srgb, var(--ls-accent) 38%, var(--ls-bg-2));
    /* text on a filled accent: the ground's own colour reads on both */
    --on-accent: var(--ls-bg-0);
    --ok: var(--ls-green);
    --ok-soft: color-mix(in srgb, var(--ls-green) 14%, var(--ls-bg-2));
    --ok-ink: color-mix(in srgb, var(--ls-green) 80%, var(--ls-text));
    --warn: var(--ls-amber);
    --warn-soft: color-mix(in srgb, var(--ls-amber) 14%, var(--ls-bg-2));
    --warn-ink: color-mix(in srgb, var(--ls-amber) 70%, var(--ls-text));
    --bad: var(--ls-red);
    --bad-soft: color-mix(in srgb, var(--ls-red) 12%, var(--ls-bg-2));
    --bad-ink: color-mix(in srgb, var(--ls-red) 85%, var(--ls-text));
    --quiet: color-mix(in srgb, var(--ls-text-dim) 12%, var(--ls-bg-2));
    max-width: 880px;
    margin: 0 auto;
    padding: 64px 18px 64px;
    display: flex;
    flex-direction: column;
    gap: 18px;
  }
  h1 { margin: 2px 0 0; font-size: 1.7rem; letter-spacing: -0.015em; }
  h2 { margin: 0 0 12px; font-size: 1.05rem; }
  .eyebrow {
    margin: 0; font-family: var(--ls-font-mono); font-size: 0.72rem;
    letter-spacing: 0.13em; text-transform: uppercase; color: var(--ink-3);
  }
  .tag { margin: 4px 0 0; color: var(--ink-2); font-size: 0.92rem; }
  /* Koralle als Kante, nicht als Fläche: es ist ein Vorbehalt zur Seite, keine
     Fehlermeldung der App über sich selbst. */
  .notice {
    margin-top: 16px; padding: 12px 14px;
    background: var(--card); border: 1px solid var(--line); border-left: 3px solid var(--bad);
    border-radius: 12px; display: flex; flex-direction: column; gap: 8px;
  }
  .notice p { margin: 0; font-size: 0.86rem; line-height: 1.55; color: var(--ink-2); }
  .notice strong { color: var(--ink); }
  .dismiss {
    align-self: flex-start; padding: 5px 12px;
    border: 1px solid var(--line); border-radius: 999px;
    background: transparent; color: var(--ink-2); font: inherit; font-size: 0.8rem;
    cursor: pointer;
  }
  .dismiss:hover { border-color: var(--bad); color: var(--ink); }
  .dim { color: var(--ink-2); font-size: 0.86rem; margin: 0; }
  .error { color: var(--bad); font-size: 0.9rem; }

  .card {
    background: var(--card); border: 1px solid var(--line); border-radius: 12px;
    padding: 18px 20px;
    box-shadow: 0 1px 2px rgba(20, 23, 31, 0.05);
  }
  .row { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }
  .row.spread { justify-content: space-between; }
  .cta { margin-top: 16px; }
  .pick .row { margin: 8px 0 12px; }

  .booking { display: grid; grid-template-columns: 250px 1fr; gap: 0; padding: 0; }
  .booking > aside {
    padding: 20px; border-right: 1px solid var(--line); background: var(--ground-2);
    border-radius: 12px 0 0 12px;
  }
  .booking > div { padding: 20px; }
  @media (max-width: 700px) {
    .booking { grid-template-columns: 1fr; }
    .booking > aside { border-right: 0; border-bottom: 1px solid var(--line); border-radius: 12px 12px 0 0; }
  }
  .salon { margin: 2px 0 14px; font-size: 1.15rem; font-weight: 700; }
  .field { display: flex; flex-direction: column; gap: 4px; margin-bottom: 12px; font-size: 0.84rem; color: var(--ink-2); }
  .field select, .field input {
    padding: 7px 9px; border: 1px solid var(--line); border-radius: 8px;
    font: inherit; font-size: 0.92rem; color: var(--ink); background: var(--card);
  }
  .note {
    margin: 14px 0 10px; padding: 10px 11px; border: 1px solid var(--accent-line);
    background: var(--accent-soft); border-radius: 9px; font-size: 0.78rem; color: var(--ink-2);
  }

  .days { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 14px; }
  .day {
    border: 1px solid var(--line); background: var(--card); color: var(--ink); border-radius: 9px;
    padding: 6px 10px; cursor: pointer; font: inherit; text-align: center; line-height: 1.2;
  }
  .day span { display: block; font-size: 0.66rem; text-transform: uppercase; color: var(--ink-3); letter-spacing: 0.06em; }
  .day b { font-size: 0.98rem; font-variant-numeric: tabular-nums; }
  .day[aria-pressed="true"] { border-color: var(--accent); background: var(--accent-soft); }
  .day[aria-pressed="true"] b { color: var(--accent); }
  .day:disabled { opacity: 0.35; cursor: not-allowed; }

  .slots { display: grid; grid-template-columns: repeat(auto-fill, minmax(84px, 1fr)); gap: 7px; }
  .slot {
    border: 1px solid var(--accent-line); background: var(--card); color: var(--accent);
    border-radius: 8px; padding: 8px 4px; cursor: pointer;
    font: inherit; font-weight: 600; font-variant-numeric: tabular-nums; font-size: 0.88rem;
  }
  .slot:hover:not(:disabled) { background: var(--accent-soft); }
  .slot[aria-pressed="true"] { background: var(--accent); color: var(--on-accent); border-color: var(--accent); }
  .slot:disabled {
    border-color: var(--line); color: var(--ink-3); background: var(--quiet);
    cursor: not-allowed; text-decoration: line-through; font-weight: 400;
  }

  .btn {
    border: 1px solid var(--accent); background: var(--accent); color: var(--on-accent);
    padding: 9px 18px; border-radius: 9px; font: inherit; font-weight: 600; cursor: pointer;
  }
  .btn:disabled { opacity: 0.4; cursor: not-allowed; }
  .btn.ghost { background: transparent; color: var(--accent); }
  .btn.ok { background: var(--ok); border-color: var(--ok); }
  .btn.sm { padding: 6px 12px; font-size: 0.85rem; }

  .switch { display: flex; border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }
  .switch button { border: 0; background: var(--card); color: var(--ink-2); font: inherit; font-size: 0.82rem; padding: 6px 11px; cursor: pointer; }
  .switch button[aria-pressed="true"] { background: var(--accent); color: var(--on-accent); font-weight: 600; }

  .mine { display: flex; flex-wrap: wrap; gap: 10px; justify-content: space-between; align-items: center; padding: 10px 0; border-top: 1px solid var(--line); }
  .when { margin: 0; font-size: 0.95rem; font-weight: 600; }
  .link { font-family: var(--ls-font-mono); font-size: 0.68rem; color: var(--ink-2); word-break: break-all; margin: 0 0 8px; }

  .pill { display: inline-block; font-size: 0.72rem; font-weight: 600; padding: 2px 8px; border-radius: 999px; background: var(--quiet); color: var(--ink-2); }
  .pill.confirmed { background: var(--ok-soft); color: var(--ok-ink); }
  .pill.pending { background: var(--warn-soft); color: var(--warn-ink); }
  .pill.declined, .pill.superseded, .pill.cancelled { background: var(--bad-soft); color: var(--bad-ink); }

  .popup { border: 1px solid var(--warn); background: var(--warn-soft); border-radius: 10px; padding: 14px 15px; margin: 12px 0; }
  .ask { display: flex; flex-wrap: wrap; gap: 10px; justify-content: space-between; align-items: center; }

  .agenda { display: flex; flex-direction: column; gap: 4px; margin-top: 12px; }
  .slotrow {
    display: grid; grid-template-columns: 62px 1fr auto; gap: 10px; align-items: center;
    padding: 8px 11px; border: 1px dashed var(--line); border-radius: 8px; background: var(--ground-2);
  }
  .slotrow.taken { border-style: solid; background: var(--card); }
  .slotrow .t { font-family: var(--ls-font-mono); font-size: 0.8rem; color: var(--ink-2); font-variant-numeric: tabular-nums; }
  .slotrow .who { font-size: 0.9rem; font-weight: 600; }
  .slotrow .who.dim { font-weight: 400; }

  /* The radio strip is a terminal in both themes, on purpose: the transport
     keeps one look, whatever the book around it does. Its colours are fixed,
     and a border keeps it apart from a dark page. */
  .radio {
    background: #0b0e15; border: 1px solid var(--line); border-radius: 12px;
    overflow: hidden; font-family: var(--ls-font-mono);
  }
  .radio-head {
    width: 100%; display: flex; flex-wrap: wrap; gap: 8px 16px; align-items: center;
    padding: 9px 14px; background: transparent; border: 0; cursor: pointer;
    color: #a8b3c7; font: inherit; font-size: 0.72rem; text-align: left;
  }
  .radio-head .title { color: #edf1f8; margin-right: auto; }
  .radio-head .chev { color: #3edc97; }
  .radio-log { padding: 6px 14px 12px; font-size: 0.72rem; line-height: 1.7; color: #edf1f8; max-height: 180px; overflow-y: auto; display: flex; flex-direction: column-reverse; }
  .radio-log .ts { color: #a8b3c7; }

  .link-state {
    display: flex; align-items: center; gap: 8px;
    margin: 0; font-size: 0.85rem; color: var(--ink-2);
  }
  .led { width: 9px; height: 9px; border-radius: 50%; background: var(--ink-3); flex: none; }
  .led.waiting { background: var(--warn); }
  .led.live { background: var(--ok); }
  .awake { display: flex; align-items: center; gap: 8px; margin: 0; }
  .airtime,
  .mismatch {
    margin: 0; padding: 10px 12px; font-size: 0.84rem; line-height: 1.5;
    border: 1px solid var(--warn); background: var(--warn-soft); color: var(--ink);
    border-radius: 9px;
  }
  .channel {
    margin: 0; font-size: 0.82rem; color: var(--ink-2);
    font-family: var(--ls-font-mono);
  }
  .channel select {
    font: inherit; font-size: 0.8rem; padding: 3px 7px;
    border: 1px solid var(--line); border-radius: 6px; background: var(--card); color: var(--ink);
  }

  footer { color: var(--ink-3); font-size: 0.8rem; }
  footer .ls-credit { display: flex; justify-content: center; margin-top: 10px; }
  footer a { color: var(--accent); }
  .build { font-family: var(--ls-font-mono); font-size: 0.7rem; }
</style>
