// SPDX-License-Identifier: GPL-3.0-only
/**
 * The stack this page needs, and nothing else.
 *
 * P11 asks one question — *can a device that has lost everything get the list
 * back, with the same identity, allowed to write?* — so everything here is
 * arranged to answer it and to be visibly incapable of cheating:
 *
 *   · **no network path between the phones.** libp2p listens nowhere and dials
 *     nobody; there is no relay, no pubsub, no sync. Whatever crosses between
 *     the two devices crosses as a backup and a pointer, over HTTPS, or it
 *     does not cross at all.
 *   · **nothing stored that matters.** The identity is derived from the
 *     security key every time. The database lives in an in-memory blockstore,
 *     so "forget everything" is a reload away from being true.
 *
 * The procedure itself is the bridge's, written up in
 * https://github.com/NiKrause/orbitdb-storage-bridge/blob/main/docs/RECOVERY-ON-A-SECOND-DEVICE.md
 */
import { createHelia } from "helia";
import { webSockets } from "@libp2p/websockets";
import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { MemoryBlockstore } from "blockstore-core";
import { MemoryDatastore } from "datastore-core";
import {
  createOrbitDB,
  Identities,
  useIdentityProvider,
  IPFSAccessController,
} from "@orbitdb/core";
import {
  restoreIdentityFromAuthenticator,
  OrbitDBWebAuthnIdentityProviderFunction,
} from "@le-space/orbitdb-identity-provider-webauthn-did";
import { dehydrate, hydrate } from "@le-space/orbitdb-storage-bridge/dehydrate";
import { createAlephBackend } from "@le-space/orbitdb-storage-bridge/backends/aleph";

/** One label for this demo's pointer, so one key can name other things too. */
export const LABEL = "funkpost-recovery-demo";
const DATABASE_NAME = "recovery-demo";

/**
 * Ask the security key who this is.
 *
 * Two touches: the first reads the PRF value with the PIN, the second signs
 * again so the public key — which an assertion does not carry — can be
 * recovered from the pair. Returns the DID, the derived signing key, and the
 * credential the OrbitDB identity provider needs.
 */
export async function identityFromKey({ onTouch } = {}) {
  const restored = await restoreIdentityFromAuthenticator({
    rpId: location.hostname,
    onTouch,
  });
  return {
    did: restored.did,
    signingKey: restored.signingKey,
    credential: {
      rawCredentialId: restored.credentialId,
      publicKey: restored.publicKey,
      prfInput: restored.prfInput,
    },
  };
}

/**
 * Helia and OrbitDB, with the passkey's identity.
 *
 * The identity provider derives the signing key from the PRF output and binds
 * it to the DID, which costs one more touch of the key the first time.
 */
export async function createStack({ credential }) {
  const helia = await createHelia({
    blockstore: new MemoryBlockstore(),
    datastore: new MemoryDatastore(),
    libp2p: {
      // Listening nowhere and dialling nobody is the point, not a limitation:
      // nothing can quietly sync behind the demo's back.
      addresses: { listen: [] },
      transports: [webSockets()],
      connectionEncrypters: [noise()],
      streamMuxers: [yamux()],
      peerDiscovery: [],
      services: {},
    },
  });

  useIdentityProvider(OrbitDBWebAuthnIdentityProviderFunction);
  // `ipfs`, so identity documents are blocks: a restored database is full of
  // entries by an identity this device never minted, and without it they
  // cannot be verified — the log would come back empty and say nothing.
  const identities = await Identities({ ipfs: helia });
  const identity = await identities.createIdentity({
    provider: OrbitDBWebAuthnIdentityProviderFunction({
      webauthnCredential: credential,
      signingKeyType: "secp256k1",
    }),
  });

  const orbitdb = await createOrbitDB({
    ipfs: helia,
    identity,
    identities,
    directory: `./recovery-${identity.id.slice(-8)}`,
  });
  return { helia, orbitdb, identity };
}

/** A list only this identity may write to. */
export async function createList({ orbitdb, identity }) {
  return orbitdb.open(DATABASE_NAME, {
    type: "events",
    sync: false, // there is no path to sync over, by design
    AccessController: IPFSAccessController({ write: [identity.id] }),
  });
}

/** Back the list up and publish the pointer the key's own secret names. */
export async function backUp({ orbitdb, address, signingKey }) {
  return dehydrate({
    orbitdb,
    address,
    seed: signingKey,
    label: LABEL,
    backend: createAlephBackend(),
  });
}

/** Find the pointer with the key alone, and open what it points at. */
export async function bringBack({ orbitdb, signingKey }) {
  return hydrate({
    orbitdb,
    seed: signingKey,
    label: LABEL,
    open: { sync: false },
  });
}

/**
 * Forget everything this device holds: the blocks are in memory anyway, and
 * the keystore and identities are not. A reload then has nothing left to find.
 */
export async function forgetEverything() {
  try {
    localStorage.clear();
  } catch {
    // a browser that refuses storage has nothing to forget
  }
  const databases = (await indexedDB.databases?.()) ?? [];
  await Promise.all(
    databases
      .filter((database) => database.name)
      .map(
        (database) =>
          new Promise((resolve) => {
            const request = indexedDB.deleteDatabase(database.name);
            request.onsuccess = request.onerror = request.onblocked = () => resolve();
          }),
      ),
  );
}
