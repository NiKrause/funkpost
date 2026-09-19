<!-- SPDX-License-Identifier: GPL-3.0-only -->
<script>
  /**
   * P11 on two phones: a list, a security key, and a device that has lost
   * everything.
   *
   * Seven steps, in the order the test runs them, and each says what it
   * proved rather than only that it worked. The numbers on screen — the DID
   * fingerprint above all — are what the two phones are compared by: if they
   * differ, nothing that follows means anything, and the page says so.
   */
  import { onMount } from "svelte";
  import {
    identityFromKey,
    createStack,
    createList,
    backUp,
    bringBack,
    forgetEverything,
  } from "./stack.js";

  const build = __BUILD_INFO__;

  let identity = $state(null); // { did, signingKey, credential }
  let stack = $state(null);
  let db = $state(null);
  let entries = $state([]);
  let pointer = $state(null); // what the last backup published
  let newText = $state("");
  let busy = $state(""); // which step is running
  let error = $state("");
  let touches = $state("");
  let log = $state([]);

  const say = (line) =>
    (log = [`${new Date().toISOString().slice(11, 19)} ${line}`, ...log].slice(0, 40));

  /** Eight bytes of a hash, in pairs — enough to compare two phones by eye. */
  async function fingerprint(value) {
    const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    return [...digest.slice(0, 8)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("")
      .replace(/(.{4})/g, "$1 ")
      .trim();
  }

  let didFingerprint = $state("");
  let keyFingerprint = $state("");

  const refresh = async () => {
    entries = db ? (await db.all()).map((entry) => entry.value) : [];
  };

  async function step(name, work) {
    if (busy) return;
    busy = name;
    error = "";
    try {
      await work();
    } catch (e) {
      error = e?.message ?? String(e);
      say(`! ${name} failed: ${error}`);
    } finally {
      busy = "";
      touches = "";
    }
  }

  const useTheKey = () =>
    step("key", async () => {
      say("asking the security key — two touches");
      identity = await identityFromKey({
        onTouch: ({ touch, of }) => (touches = `touch ${touch} of ${of}`),
      });
      didFingerprint = await fingerprint(identity.did);
      keyFingerprint = await fingerprint(identity.signingKey);
      say(`identity: ${identity.did.slice(0, 24)}…`);
      touches = "binding the signing key — one more touch";
      stack = await createStack({ credential: identity.credential });
      say("OrbitDB is running with that identity");
    });

  const makeList = () =>
    step("list", async () => {
      db = await createList({ orbitdb: stack.orbitdb, identity: stack.identity });
      say(`list open: ${db.address}`);
      await refresh();
    });

  const add = () =>
    step("add", async () => {
      const text = newText.trim();
      if (!text) return;
      await db.add(text);
      newText = "";
      say(`wrote »${text}«`);
      await refresh();
    });

  const dehydrateNow = () =>
    step("backup", async () => {
      say("backing up, and publishing the pointer…");
      pointer = await backUp({
        orbitdb: stack.orbitdb,
        address: db.address,
        signingKey: identity.signingKey,
      });
      say(`pointer ${pointer.name} → ${pointer.metadataCID} (${pointer.blocks} blocks)`);
    });

  const hydrateNow = () =>
    step("restore", async () => {
      say("asking for the pointer, with the key alone…");
      const found = await bringBack({
        orbitdb: stack.orbitdb,
        signingKey: identity.signingKey,
      });
      db = found.db;
      pointer = { name: found.name, metadataCID: found.metadataCID, blocks: found.blocks };
      say(`restored ${found.address} — ${found.blocks} blocks, nothing carried over`);
      await refresh();
    });

  const forget = () =>
    step("forget", async () => {
      await forgetEverything();
      say("everything on this device is gone — reloading");
      setTimeout(() => location.reload(), 600);
    });

  onMount(() => {
    say("nothing is stored here; the key is asked every time");
  });
</script>

<main>
  <h1>recovery</h1>
  <p class="tag">
    a list, a security key, and a device that has lost everything — P11 on two phones
  </p>

  <section>
    <h2>1 · The key</h2>
    <p class="dim">
      Two touches: the first reads the secret with the PIN, the second signs again so the
      public key can be recovered from the pair. A third binds the signing key.
    </p>
    <button data-testid="use-key" disabled={Boolean(busy)} onclick={useTheKey}>
      {busy === "key" ? touches || "asking…" : identity ? "Ask again" : "Use my security key"}
    </button>
    {#if identity}
      <dl>
        <dt>DID fingerprint</dt>
        <dd class="fp" data-testid="did-fingerprint">{didFingerprint}</dd>
        <dt>signing key fingerprint</dt>
        <dd class="fp" data-testid="key-fingerprint">{keyFingerprint}</dd>
      </dl>
      <p class="dim">
        <strong>Compare these two lines on both phones.</strong> If they differ, the identity did
        not travel and nothing below proves anything — usually the wrong passkey was picked.
      </p>
    {/if}
  </section>

  {#if identity && stack}
    <section>
      <h2>2 · The list</h2>
      {#if db}
        <p class="dim addr">{db.address}</p>
        <ul>
          {#each entries as entry, index (index)}
            <li>{entry}</li>
          {/each}
        </ul>
        {#if entries.length === 0}<p class="dim">nothing in it yet</p>{/if}
        <form
          onsubmit={(event) => {
            event.preventDefault();
            add();
          }}
        >
          <input aria-label="new entry" placeholder="Milch kaufen…" bind:value={newText} />
          <button type="submit" disabled={!newText.trim() || Boolean(busy)}>Add</button>
        </form>
      {:else}
        <p class="dim">
          On the phone that starts: make the list. On the phone that is recovering: skip
          this and go straight to <em>restore</em>.
        </p>
        <button data-testid="make-list" disabled={Boolean(busy)} onclick={makeList}>
          Make the list
        </button>
      {/if}
    </section>

    <section>
      <h2>3 · Off this device</h2>
      <p class="dim">
        The backup goes to Aleph without an account; the pointer goes under a name this
        key derives, so the other phone needs no address, no CID and no file.
      </p>
      <button data-testid="dehydrate" disabled={!db || Boolean(busy)} onclick={dehydrateNow}>
        {busy === "backup" ? "backing up…" : "Back up and publish the pointer"}
      </button>
      <button data-testid="hydrate" disabled={Boolean(busy)} onclick={hydrateNow}>
        {busy === "restore" ? "restoring…" : "Restore with the key alone"}
      </button>
      {#if pointer}
        <dl>
          <dt>pointer</dt>
          <dd class="fp" data-testid="pointer-name">{pointer.name}</dd>
          <dt>backup</dt>
          <dd class="fp">{pointer.metadataCID}</dd>
        </dl>
      {/if}
    </section>

    <section class="danger">
      <h2>4 · Lose this device</h2>
      <p class="dim">
        Deletes everything this origin holds and reloads. The security key keeps the
        passkey, which is the whole point: afterwards, <em>Use my security key</em> and
        <em>Restore</em> have to be enough.
      </p>
      <button data-testid="forget" disabled={Boolean(busy)} onclick={forget}>
        Forget everything on this device
      </button>
    </section>
  {/if}

  {#if error}
    <p class="error" data-testid="error">{error}</p>
  {/if}

  <section>
    <h2>What happened</h2>
    <div class="log">
      {#each log as line, index (index)}<div>{line}</div>{/each}
    </div>
  </section>

  <footer>
    <a href="https://github.com/NiKrause/funkpost/blob/main/ROADMAP.md">roadmap</a> ·
    <a
      href="https://github.com/NiKrause/@le-space/orbitdb-storage-bridge/blob/main/docs/RECOVERY-ON-A-SECOND-DEVICE.md"
      >how it works</a
    >
    · GPL-3.0 ·
    <span class="build">funkpost {build.version} · {build.commit} · {build.builtAt}</span>
  </footer>
</main>

<style>
  :global(body) {
    margin: 0;
    background: #0b0e15;
    color: #e7ebf3;
    font:
      15px/1.5 system-ui,
      sans-serif;
  }
  main {
    max-width: 44rem;
    margin: 0 auto;
    padding: 20px 16px 48px;
  }
  h1 {
    margin: 0;
    font-size: 1.7rem;
  }
  h2 {
    margin: 0 0 8px;
    font-size: 1.05rem;
  }
  .tag {
    color: #8b93a5;
    margin: 4px 0 20px;
  }
  section {
    border: 1px solid #222a38;
    border-radius: 10px;
    padding: 14px 16px;
    margin: 0 0 14px;
  }
  section.danger {
    border-color: #4a2330;
  }
  .dim {
    color: #8b93a5;
  }
  .addr,
  .fp {
    font-family: ui-monospace, monospace;
    overflow-wrap: anywhere;
  }
  .fp {
    font-size: 1.1rem;
    letter-spacing: 0.02em;
    margin: 0 0 10px;
  }
  dl {
    margin: 12px 0 0;
  }
  dt {
    color: #8b93a5;
    font-size: 0.85rem;
  }
  button {
    background: #1b2433;
    color: #e7ebf3;
    border: 1px solid #2c3648;
    border-radius: 8px;
    padding: 10px 14px;
    font: inherit;
    margin: 0 8px 8px 0;
  }
  button:disabled {
    opacity: 0.5;
  }
  .danger button {
    border-color: #6b2f3f;
  }
  form {
    display: flex;
    gap: 8px;
    margin-top: 10px;
  }
  input {
    flex: 1;
    background: #111827;
    color: inherit;
    border: 1px solid #2c3648;
    border-radius: 8px;
    padding: 10px;
    font: inherit;
  }
  ul {
    margin: 8px 0;
    padding-left: 20px;
  }
  .error {
    color: #ff9c9c;
    border: 1px solid #6b2f3f;
    border-radius: 8px;
    padding: 10px 12px;
  }
  .log {
    font-family: ui-monospace, monospace;
    font-size: 0.8rem;
    color: #9fb0c8;
    background: #0d1420;
    border-radius: 8px;
    padding: 10px;
    max-height: 220px;
    overflow: auto;
  }
  footer {
    color: #6d768a;
    font-size: 0.8rem;
    margin-top: 18px;
  }
  footer a {
    color: #7fb8ff;
  }
  .build {
    font-family: ui-monospace, monospace;
  }
</style>
