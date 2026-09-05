// SPDX-License-Identifier: GPL-3.0-only
/**
 * Surviving a reload.
 *
 * Until now everything lived in memory: a refresh, a phone locking its screen
 * hard enough to discard the tab, or the PWA being killed in the background
 * lost the whole book — and the only way back was to greet the mesh and hope
 * somebody answered. On a duty-cycled link that is not a recovery strategy.
 *
 * **Why not `y-indexeddb`.** It is the obvious answer and it only covers half
 * the problem: since issue #45 the bookings are not in the Yjs document at all,
 * they are in the claim log. y-indexeddb would faithfully persist the shop's
 * opening hours and lose every appointment. So both are stored here, in one
 * place, with no dependency — which also keeps a single story about what is
 * kept and where.
 *
 * The claim log is unusually easy to persist, and not by accident: records are
 * **immutable and self-describing**, so there is no migration, no merge on
 * load, and no chance of storing something half-written. Put them back and the
 * log is exactly what it was.
 */

const DB_VERSION = 1;
const STORE_DOC = "doc";
const STORE_RECORDS = "records";

const open = (name) =>
  new Promise((resolve, reject) => {
    const request = indexedDB.open(name, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_DOC)) db.createObjectStore(STORE_DOC);
      if (!db.objectStoreNames.contains(STORE_RECORDS)) db.createObjectStore(STORE_RECORDS);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

const run = (db, store, mode, work) =>
  new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const result = work(tx.objectStore(store));
    tx.oncomplete = () => resolve(result?.result ?? result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });

/**
 * Load what we had, then keep saving what arrives.
 *
 * @param {Object} options
 * @param {string} options.room Storage is per room, so two demos in one browser
 *   do not read each other's book
 * @param {Object} options.doc The `Y.Doc` holding the shop rules
 * @param {Object} options.log The claim log holding the bookings
 * @param {Object} options.Y The Yjs module (passed in so this file imports none)
 * @param {(error: Error) => void} [options.onError]
 * @returns {Promise<{ restored: number, close: Function, wipe: Function }>}
 */
export async function attachPersistence({ room, doc, log, Y, onError = null }) {
  const fail = (error) => {
    // A browser in private mode, or with storage blocked, simply has no
    // persistence. Everything else still works, so this is not a reason to
    // put an error in front of somebody trying to book a haircut.
    if (onError) onError(error);
  };

  let db;
  try {
    db = await open(`funkpost-termine:${room}`);
  } catch (error) {
    fail(error);
    return { restored: 0, close() {}, async wipe() {} };
  }

  // ── restore ────────────────────────────────────────────────────────────
  let restored = 0;
  try {
    const update = await run(db, STORE_DOC, "readonly", (store) => store.get("state"));
    if (update) Y.applyUpdate(doc, new Uint8Array(update), "persistence");

    const records = await run(db, STORE_RECORDS, "readonly", (store) => store.getAll());
    for (const record of records ?? []) {
      // Straight in: these were verified when they were first accepted, and a
      // record cannot have changed since — that is what immutable means.
      log.put(record);
      restored++;
    }
  } catch (error) {
    fail(error);
  }

  // ── keep saving ────────────────────────────────────────────────────────
  const saveDoc = () => {
    run(db, STORE_DOC, "readwrite", (store) =>
      store.put(Y.encodeStateAsUpdate(doc), "state"),
    ).catch(fail);
  };

  const saveRecord = (record, key) => {
    run(db, STORE_RECORDS, "readwrite", (store) => store.put(record, key)).catch(fail);
  };

  const dropKeys = (keys) => {
    if (keys.length === 0) return;
    run(db, STORE_RECORDS, "readwrite", (store) => {
      for (const key of keys) store.delete(key);
    }).catch(fail);
  };

  // The document is small and rarely written, so a whole-state snapshot per
  // change is cheaper than tracking incremental updates — and cannot drift.
  const onDocUpdate = (_update, origin) => {
    if (origin === "persistence") return; // that was us, loading
    saveDoc();
  };
  doc.on("update", onDocUpdate);

  const detachLog = log.onPut(saveRecord);
  const detachForget = log.onForget(dropKeys);

  return {
    restored,
    close() {
      doc.off("update", onDocUpdate);
      detachLog();
      detachForget();
      db.close();
    },
    /** Forget this room entirely — the Reset button. */
    async wipe() {
      try {
        await run(db, STORE_DOC, "readwrite", (store) => store.clear());
        await run(db, STORE_RECORDS, "readwrite", (store) => store.clear());
      } catch (error) {
        fail(error);
      }
    },
  };
}
