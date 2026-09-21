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
  import { creditHTML } from "@le-space/funkpost-brand";
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
  let details = $state(false); // the technical layer, behind one button
  let done = $state({}); // step name → true once it has worked
  let failedStep = $state("");

  const STATUS_TEXT = { todo: "not yet", running: "running…", done: "done", failed: "failed" };
  const status = (name) =>
    busy === name ? "running" : failedStep === name ? "failed" : done[name] ? "done" : "todo";

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
    failedStep = "";
    try {
      await work();
      done = { ...done, [name]: true };
    } catch (e) {
      error = e?.message ?? String(e);
      failedStep = name;
      say(`! ${name} failed: ${error}`);
    } finally {
      busy = "";
      touches = "";
    }
  }

  /** What each touch of step 1 is for, shown while it is being asked for. */
  const TOUCH = {
    1: "Touch 1 of 3 — the key's secret for this site (with PIN)",
    2: "Touch 2 of 3 — a second signature, to recover the public key",
    3: "Touch 3 of 3 — the passkey vouches for the signing key (with PIN)",
  };

  const useTheKey = () =>
    step("key", async () => {
      say("asking the security key — three touches");
      identity = await identityFromKey({
        onTouch: ({ touch }) => {
          touches = TOUCH[touch];
          say(TOUCH[touch]);
        },
      });
      didFingerprint = await fingerprint(identity.did);
      keyFingerprint = await fingerprint(identity.signingKey);
      say(`identity: ${identity.did.slice(0, 24)}…`);
      touches = TOUCH[3];
      say(TOUCH[3]);
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
  <p class="tag">A list that survives losing the phone — with nothing but your security key.</p>

  <section class="intro">
    <p>
      Your security key holds a secret that never leaves it. From that secret this page works
      out who you are and where your backup lives — the same on every phone. So a phone that
      has lost everything, or a new one, needs nothing but the key to find the list again and
      go on writing to it.
    </p>
    <h2>The test, on two phones</h2>
    <ol class="plan">
      <li><strong>Phone A:</strong> steps 1, 2 and 3 — who you are, a list, a backup.</li>
      <li>
        <strong>Phone B</strong>, or phone A after step 4: step 1 with the same key, then step 5.
      </li>
      <li>
        <strong>It worked</strong> if the list comes back on phone B and accepts a new entry
        there.
      </li>
    </ol>
    <button
      class="ghost"
      data-testid="details"
      aria-expanded={details}
      onclick={() => (details = !details)}
    >
      {details ? "Hide the technical details" : "Show the technical details"}
    </button>

    <div class="tech explain" data-testid="how-it-works" hidden={!details}>
      <h3>The three touches of step 1</h3>
      <ol>
        <li>
          <strong>The secret.</strong> <code>navigator.credentials.get()</code> names no
          credential — the key offers its passkey for this site — and asks the PRF extension with
          a fixed input: SHA-256 of a label and this site's name, the same on every phone. The
          key answers with the credential id, a signature, and a 32-byte PRF output computed
          inside the key from a secret that never leaves it. With PIN, because the key gives a
          different PRF answer without one.
        </li>
        <li>
          <strong>The public key.</strong> A WebAuthn answer carries no public key, so it is
          worked out: the same credential signs a second, fresh challenge, every P-256 signature
          fits exactly two candidate public keys, and only the key's own fits both. Checked
          against both signatures, it becomes the identity, <code>did:key:z…</code>.
        </li>
        <li>
          <strong>The binding.</strong> An OrbitDB identity carries two signatures: the signing
          key signs the DID, and the passkey signs the signing key's public key together with
          that signature. The second is one more WebAuthn call — the passkey vouching that this
          key writes for it. Every entry the list accepts is checked against it.
        </li>
      </ol>
      <h3>Derived, never stored</h3>
      <ul>
        <li>
          <strong>Signing key</strong> (secp256k1): HKDF-SHA-256 over the PRF output, with the DID
          in the info.
        </li>
        <li>
          <strong>Pointer key</strong> (Ed25519): HKDF-SHA-256 over the signing key, with this
          page's label in the info. Its public key is the pointer's name, <code>k51…</code>.
        </li>
      </ul>
      <h3>Every request, and when</h3>
      <ul>
        <li>
          <strong>Steps 1, 2 and 4:</strong> none. The phone talks to the key over USB, NFC or
          Bluetooth, not over the internet.
        </li>
        <li>
          <strong>Step 3:</strong> <code>POST ipfs.aleph.cloud/api/v0/add</code>, twice — the list
          as one CAR file, every block it is made of, then a small JSON that names it. Then
          <code>PUT delegated-ipfs.dev/routing/v1/ipns/k51…</code>: an IPNS record, signed by the
          pointer key, pointing at the JSON, valid for 30 days.
        </li>
        <li>
          <strong>Step 5:</strong> <code>GET delegated-ipfs.dev/routing/v1/ipns/k51…</code>, and the
          record is checked against the name. Then <code>GET ipfs.aleph.cloud/ipfs/…</code> for the
          JSON and the CAR — <code>dweb.link</code>, then <code>ipfs.io</code>, if Aleph does not
          answer — and every block is checked against its hash before the list opens.
        </li>
      </ul>
      <p class="dim">
        Each step's own values appear under it once it has run; what happened, line by line, is
        at the <a href="#log">bottom of the page</a>.
      </p>
    </div>
  </section>

  {#if error}
    <p class="error" data-testid="error">{error}</p>
  {/if}

  <section class="step" data-status={status("key")}>
    <header>
      <h2><span class="n">1</span> Tell the page who you are</h2>
      <span class="badge">{STATUS_TEXT[status("key")]}</span>
    </header>
    <p>
      Touch your security key three times. The first two touches recover your identity from
      the secret on the key; the third lets that identity sign what you write. The same key
      gives the same identity on every phone.
    </p>
    <p class="who">
      <span class="chip">your security key</span> — nothing goes on the internet
    </p>
    <button data-testid="use-key" disabled={Boolean(busy)} onclick={useTheKey}>
      {busy === "key" ? "asking the key…" : identity ? "Ask again" : "Use my security key"}
    </button>
    {#if busy === "key" && touches}
      <p class="touch-now" data-testid="touch-now">{touches}</p>
    {/if}
    {#if identity}
      <p class="dim">
        To compare two phones, show the technical details: the two lines there must be the
        same on both.
      </p>
      <div class="tech" hidden={!details}>
        <dl>
          <dt>DID fingerprint</dt>
          <dd class="fp" data-testid="did-fingerprint">{didFingerprint}</dd>
          <dt>signing key fingerprint</dt>
          <dd class="fp" data-testid="key-fingerprint">{keyFingerprint}</dd>
        </dl>
        <p class="dim">
          If they differ, the identity did not travel and nothing below proves anything —
          usually the wrong passkey was picked.
        </p>
      </div>
    {/if}
  </section>

  <section class="step" data-status={db ? "done" : status("list")}>
    <header>
      <h2><span class="n">2</span> Your list</h2>
      <span class="badge">{db ? "open" : STATUS_TEXT[status("list")]}</span>
    </header>
    {#if db}
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
      <div class="tech" hidden={!details}>
        <p class="dim addr">{db.address}</p>
      </div>
    {:else}
      <p>
        On phone A: make the list, and write a few entries. On phone B: skip this and go to
        step 5 — the list comes back here.
      </p>
      <button data-testid="make-list" disabled={!stack || Boolean(busy)} onclick={makeList}>
        Make the list
      </button>
      {#if !stack}<p class="dim">Needs step 1 first.</p>{/if}
    {/if}
    <p class="who">
      <span class="chip">nobody</span> — it stays on this phone until step 3
    </p>
  </section>

  <section class="step" data-status={status("backup")}>
    <header>
      <h2><span class="n">3</span> Put it somewhere safe</h2>
      <span class="badge">{STATUS_TEXT[status("backup")]}</span>
    </header>
    <p>
      Uploads the list as one file to Aleph, a public storage network, and publishes a small
      signed note — the <em>pointer</em> — under a name only your key can work out. The
      pointer says where the file is, so the other phone needs nothing else.
    </p>
    <p class="who">
      <span class="chip">Aleph · ipfs.aleph.cloud</span> the file, no account
      <span class="chip">delegated-ipfs.dev</span> the pointer
    </p>
    <p class="note">
      Aleph takes the file but does not promise to keep it: that needs a storage order signed
      by a wallet with credit on Aleph. Fine for this test, not yet for a list you would miss.
      The pointer asks to be kept for 30 days.
    </p>
    <button data-testid="dehydrate" disabled={!db || Boolean(busy)} onclick={dehydrateNow}>
      {busy === "backup" ? "backing up…" : "Back up and publish the pointer"}
    </button>
    {#if !db}<p class="dim">Needs a list first.</p>{/if}
    {#if pointer && done.backup}
      <div class="tech" hidden={!details}>
        <dl>
          <dt>pointer</dt>
          <dd class="fp" data-testid="pointer-name">{pointer.name}</dd>
          <dt>backup</dt>
          <dd class="fp">{pointer.metadataCID}</dd>
        </dl>
      </div>
    {/if}
  </section>

  <section class="step danger">
    <header>
      <h2><span class="n">4</span> Lose the phone</h2>
    </header>
    <p>
      Deletes everything this page stored on this phone, and reloads. The security key keeps
      its secret, which is the point: afterwards, steps 1 and 5 have to be enough.
    </p>
    <p class="who"><span class="chip">nobody</span></p>
    <button data-testid="forget" disabled={Boolean(busy)} onclick={forget}>
      Forget everything on this phone
    </button>
  </section>

  <section class="step" data-status={status("restore")}>
    <header>
      <h2><span class="n">5</span> Get it back</h2>
      <span class="badge">{STATUS_TEXT[status("restore")]}</span>
    </header>
    <p>
      Asks for the pointer under your key's name, fetches the file it names and opens the list
      — nothing to type in, nothing carried over. Then write an entry in step 2: the list
      accepts it because it is still you.
    </p>
    <p class="who">
      <span class="chip">delegated-ipfs.dev</span> the pointer
      <span class="chip">Aleph's gateway, then dweb.link, ipfs.io</span> the file
    </p>
    <button data-testid="hydrate" disabled={!stack || Boolean(busy)} onclick={hydrateNow}>
      {busy === "restore" ? "restoring…" : "Get my list back"}
    </button>
    {#if !stack}<p class="dim">Needs step 1 first, with the same key.</p>{/if}
    {#if done.restore}
      <p class="ok">Your list is back, in step 2. Write an entry there to prove it is still yours.</p>
      {#if pointer}
        <div class="tech" hidden={!details}>
          <dl>
            <dt>pointer</dt>
            <dd class="fp">{pointer.name}</dd>
            <dt>backup</dt>
            <dd class="fp">{pointer.metadataCID} · {pointer.blocks} blocks</dd>
          </dl>
        </div>
      {/if}
    {/if}
  </section>

  <section class="tech" id="log" hidden={!details}>
    <h2>What happened</h2>
    <div class="log">
      {#each log as line, index (index)}<div>{line}</div>{/each}
    </div>
  </section>

  <footer>
    <a href="https://github.com/NiKrause/funkpost/blob/main/ROADMAP.md">roadmap</a> ·
    <a
      href="https://github.com/NiKrause/orbitdb-storage-bridge/blob/main/docs/RECOVERY-ON-A-SECOND-DEVICE.md"
      >how it works</a
    >
    · GPL-3.0 ·
    <span class="build">funkpost {build.version} · {build.commit} · {build.builtAt}</span>
    <p class="ls-credit">{@html creditHTML("en")}</p>
  </footer>
</main>

<style>
  :global(body) {
    margin: 0;
    background: #0b0e15;
    color: #e7ebf3;
    font: 15px/1.5 var(--ls-font);
  }
  /* 64 px on top: the Le Space pill sits in the first 56. */
  main {
    max-width: 44rem;
    margin: 0 auto;
    padding: 64px 16px 48px;
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
    font-family: var(--ls-font-mono);
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
    font-family: var(--ls-font-mono);
    font-size: 0.8rem;
    color: #9fb0c8;
    background: #0d1420;
    border-radius: 8px;
    padding: 10px;
    max-height: 220px;
    overflow: auto;
  }
  footer .ls-credit {
    display: flex;
    margin-top: 12px;
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
    font-family: var(--ls-font-mono);
  }
  .intro p {
    margin: 0 0 10px;
  }
  .plan {
    margin: 4px 0 12px;
    padding-left: 20px;
  }
  .plan li {
    margin: 4px 0;
  }
  .step header {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 12px;
  }
  .step h2 {
    display: flex;
    align-items: baseline;
    gap: 10px;
  }
  .step p {
    margin: 0 0 10px;
  }
  /* The number is the order the test runs in, not decoration. */
  .n {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: none;
    width: 1.6em;
    height: 1.6em;
    border: 1px solid #2c3648;
    border-radius: 50%;
    font-family: var(--ls-font-mono);
    font-size: 0.85rem;
  }
  .badge {
    flex: none;
    font-size: 0.75rem;
    color: #8b93a5;
  }
  .step[data-status="running"] {
    border-color: #6b5a2a;
  }
  .step[data-status="running"] .badge {
    color: #ffc24b;
  }
  .step[data-status="done"] {
    border-color: #1f5a44;
  }
  .step[data-status="done"] .badge,
  .step[data-status="done"] .n {
    color: #3edc97;
    border-color: #3edc97;
  }
  .step[data-status="failed"] {
    border-color: #6b2f3f;
  }
  .step[data-status="failed"] .badge {
    color: #ff9c9c;
  }
  .who {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px 8px;
    font-size: 0.85rem;
    color: #8b93a5;
  }
  .chip {
    font-family: var(--ls-font-mono);
    font-size: 0.75rem;
    color: #c7d7f0;
    background: #141c2b;
    border: 1px solid #2c3648;
    border-radius: 999px;
    padding: 2px 9px;
  }
  .note {
    font-size: 0.85rem;
    color: #d9c38f;
    border-left: 2px solid #6b5a2a;
    padding-left: 10px;
  }
  .ok {
    color: #3edc97;
  }
  .tech {
    margin-top: 10px;
    padding-top: 10px;
    border-top: 1px dashed #222a38;
  }
  section.tech {
    border-top: 1px solid #222a38;
  }
  button.ghost {
    background: none;
  }
  .explain h3 {
    margin: 14px 0 6px;
    font-size: 0.95rem;
  }
  .explain ol,
  .explain ul {
    margin: 0 0 8px;
    padding-left: 20px;
  }
  .explain li {
    margin: 6px 0;
  }
  .explain a {
    color: #7fb8ff;
  }
  code {
    font-size: 0.85em;
    color: #c7d7f0;
    overflow-wrap: anywhere;
  }
  .touch-now {
    color: #ffc24b;
    font-weight: 600;
  }
  button:focus-visible {
    outline: 2px solid #58c7f3;
    outline-offset: 2px;
  }
</style>
