// SPDX-License-Identifier: GPL-3.0-only
/**
 * Keeping the app shell, so the demo opens where it is meant to be used.
 *
 * The point of this thing is that it works where there is no internet. An app
 * that needs the internet to start is a poor advertisement for that — and a
 * phone carried to a field to test a radio has usually left the coverage
 * behind before it gets there.
 *
 * Runtime caching, deliberately, rather than a precache manifest: whatever the
 * app fetches is kept, so the second visit is offline-capable. Being honest
 * about what that fixes and what it does not:
 *
 * - Somebody who has opened this app before — which is everybody who booked
 *   through it — can open their link with no network at all.
 * - A stranger tapping a cold link on a device that has never loaded the page
 *   still needs the network once. No service worker can change that, which is
 *   why the QR code at the counter is the offline-native path.
 *
 * Stale-while-revalidate for assets, network-first for the shell. The split
 * is not a preference: an asset is named by content hash and is therefore
 * immutable, while the shell *names those hashes*. A cached shell served to an
 * online device asks for a bundle the next deploy has deleted, and the page is
 * blank. Offline the shell still answers from the cache, because fetch fails
 * immediately when there is no network.
 *
 * One trap worth naming, because it costs an afternoon: the Cache API honours
 * `Vary` by default, and plenty of servers answer with `Vary: Origin`. A stored
 * entry then fails to match a later request for the very same URL, the lookup
 * silently misses, and the page is blank offline while the cache visibly holds
 * exactly what it wanted. Every match here passes `ignoreVary`.
 */

const CACHE = "funkpost-mesh-todo-v2";

self.addEventListener("install", (event) => {
  // Take the shell now, so the very first reload is already covered.
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.add("./")).catch(() => {}),
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) => Promise.all(names.filter((n) => n !== CACHE).map((n) => caches.delete(n))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // never our business

  // A navigation carries no fragment, so `#/b/…` arrives as a plain request
  // for the app root — which is exactly what we cached.
  const navigation = request.mode === "navigate";
  const key = navigation ? new Request("./", { credentials: "same-origin" }) : request;

  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const fresh = fetch(request)
        .then((response) => {
          if (response.ok) cache.put(key, response.clone());
          return response;
        })
        .catch(() => null);

      // The shell goes to the network first whenever there is one. It names
      // its bundle by content hash, so a cached shell asks for a file the next
      // deploy has already deleted: the request 404s, nothing renders, and the
      // page is blank with no error anyone can act on — while the background
      // revalidation quietly fixes a *later* visit. Measured after a deploy:
      // every navigation, at every URL, served a shell pointing at a bundle
      // that was gone. Offline this costs nothing, because fetch fails at once
      // with no network and the cached shell answers, which is the case this
      // was written for.
      if (navigation) {
        return (
          (await fresh) ??
          (await cache.match(key, { ignoreVary: true })) ??
          new Response("offline", { status: 503 })
        );
      }

      // A hashed asset is immutable: the cached copy is the right one by
      // definition, so it answers immediately and the fetch only refills.
      const hit = await cache.match(key, { ignoreVary: true });
      return hit ?? (await fresh) ?? new Response("offline", { status: 503 });
    }),
  );
});
