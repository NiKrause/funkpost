// SPDX-License-Identifier: GPL-3.0-only
/**
 * The page and its service worker must name the same cache.
 *
 * `main.js` fills the shell cache itself, because on a first visit the scripts
 * and styles are fetched before any worker controls the page — its own comment
 * says so. The worker's `activate` handler then deletes every cache that is not
 * its own. If the two names disagree, the page fills something the worker is
 * about to throw away, and `data-offline-ready="true"` promises a shell that
 * may not be there.
 *
 * They did disagree — v1 in the page, v2 in the worker — and what it produced
 * was not a clean failure but a timing-dependent one: the worker's own install
 * and runtime puts sometimes filled v2 in time, and sometimes did not. That is
 * the shape of a test that fails on CI and passes on a laptop.
 *
 * A version bump touches one file and forgets the other, so this is checked
 * rather than remembered.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (rel) =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

// Quoted, so a cache name in prose — the comments explain this very rule —
// is not mistaken for a declaration.
const cacheNamesIn = (source) => [
  ...new Set(
    (source.match(/"funkpost-[a-z-]+-v\d+"/g) ?? []).map((q) => q.slice(1, -1)),
  ),
];

// Every app that keeps an offline shell. Both had drifted, which is why this
// checks all of them rather than the one whose test happened to go red.
const APPS = ["mesh-todo", "mesh-calendar"];

describe("the offline shell cache", () => {
  for (const app of APPS) {
    describe(app, () => {
      const page = cacheNamesIn(read(`../examples/${app}/src/main.js`));
      const worker = cacheNamesIn(read(`../examples/${app}/public/sw.js`));

      test("the page and the worker name exactly one cache each", () => {
        assert.equal(page.length, 1, `page names ${page.join(", ") || "none"}`);
        assert.equal(
          worker.length,
          1,
          `worker names ${worker.join(", ") || "none"}`,
        );
      });

      test("and it is the same one", () => {
        assert.equal(
          page[0],
          worker[0],
          "the worker deletes every cache but its own, so a page filling " +
            "another name fills something about to be thrown away",
        );
      });
    });
  }
});
