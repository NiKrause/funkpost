// SPDX-License-Identifier: GPL-3.0-only
/**
 * A ride that outlives the tab it was recorded in (#180, #191).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  rideToCsv,
  heardToCsv,
  rideFilename,
  RIDE_COLUMNS,
} from "../examples/mesh-heartbeat/src/ride-file.js";

const AT = Date.UTC(2026, 9, 2, 18, 14, 59);

test("a ride is a table anyone can open", () => {
  const csv = rideToCsv(
    [
      { at: AT, n: 1, of: 3, position: { lat: 48.41161, lon: 12.76035 }, answered: 1, answeredAt: AT, answeredBy: "b38a691f" },
      { at: AT + 15_000, n: 2, of: 3, position: null, answered: null, answeredAt: AT + 1, answeredBy: null },
    ],
    { distance: (p) => (p.position ? 1234.6 : null) },
  );
  const lines = csv.trim().split("\n");
  assert.equal(lines[0], RIDE_COLUMNS.join(","));
  assert.match(lines[1], /^2026-10-02T18:14:59.000Z,1,3,48.41161,12.76035,answered,1,b38a691f,1235$/);
  assert.match(lines[2], /,2,3,,,silent,,,$/, "no place, no answer, and no invented distance");
  assert.ok(csv.endsWith("\n"), "a trailing newline, so wc -l agrees with the rows");
});

test("a beat still in the air is neither answered nor a silence", () => {
  const csv = rideToCsv([{ at: AT, n: 1, of: 3, position: null, answered: null, answeredAt: null }]);
  assert.match(csv, /,open,/);
});

test("a comma in a device name does not become a column", () => {
  // Nothing on this page generates one today, but every value in these rows
  // arrived from another device over the radio, and a file is a thing people
  // forward.
  const csv = rideToCsv([
    { at: AT, n: 1, of: 1, position: null, answered: 1, answeredAt: AT, answeredBy: 'a,b"c' },
  ]);
  const line = csv.trim().split("\n")[1];
  assert.ok(line.includes('"a,b""c"'), line);
  assert.equal(line.split(",").length, RIDE_COLUMNS.length + 1, "the quoted cell holds its comma");
});

test("the stationary half exports what reached it", () => {
  const csv = heardToCsv([
    { at: AT, type: "beat", from: "aaaa", n: 1, bytes: 49, position: { lat: 48.4, lon: 12.7 }, answered: true },
    { at: AT, type: "echo", from: "bbbb", n: 2, bytes: 34, position: null, answered: false },
  ]);
  const lines = csv.trim().split("\n");
  assert.match(lines[1], /beat,aaaa,1,49,48.4,12.7,yes$/);
  assert.match(lines[2], /echo,bbbb,2,34,,,$/, "an echo of somebody else's is not ours to answer");
});

test("the filename sorts, and says which half wrote it", () => {
  const name = rideFilename("rider", AT);
  assert.equal(name, "mesh-heartbeat-rider-2026-10-02T18-14-59.csv");
  assert.ok(name < rideFilename("rider", AT + 60_000), "and a later ride sorts after it");
});
