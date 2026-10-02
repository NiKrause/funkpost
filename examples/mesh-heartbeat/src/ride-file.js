// SPDX-License-Identifier: GPL-3.0-only
/**
 * The ride, as a file somebody can keep.
 *
 * Until now a run lived on the screen and in a screenshot (#180, #191): close
 * the tab, flatten the battery, and the only measurement of the evening was
 * gone. A ride takes an hour of somebody's time and six minutes of a rationed
 * band — it should not be the most perishable thing in the experiment.
 *
 * CSV rather than JSON, because the first thing anyone does with a ride is
 * open it in a spreadsheet and sort by distance. It is also what the field
 * notes get written from, and a column of numbers is easier to quote than a
 * tree of objects.
 *
 * Both halves export the same shape: the rider's own track and the stationary
 * device's record of what reached it produce the same columns, so two files
 * from one evening can be read side by side — which is the whole point of
 * there being two of them.
 */

/** RFC 4180: quote anything with a comma, a quote or a newline; double the quotes. */
const cell = (value) => {
  if (value == null) return "";
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};

const row = (cells) => cells.map(cell).join(",");

/** Local time, because a ride is remembered by when it felt like, not in UTC. */
const clock = (at) => (at == null ? "" : new Date(at).toISOString());

export const RIDE_COLUMNS = [
  "time",
  "beat",
  "of",
  "lat",
  "lon",
  "result",
  "answered_beat",
  "answered_by",
  "metres_from_station",
];

/**
 * @param {Array<Object>} points oldest first: { at, n, of, position, answered, answeredBy }
 * @param {Object} [options]
 * @param {(point: Object) => number|null} [options.distance] metres to the
 *   stationary device, which only the page can work out — it holds the other
 *   position and this module deliberately does not
 */
export function rideToCsv(points, { distance = () => null } = {}) {
  const lines = [row(RIDE_COLUMNS)];
  for (const point of points) {
    const metres = distance(point);
    lines.push(
      row([
        clock(point.at),
        point.n ?? "",
        point.of ?? "",
        point.position?.lat ?? "",
        point.position?.lon ?? "",
        // Three words, not a colour: a file is read without the page's legend.
        point.answered != null ? "answered" : point.answeredAt === null ? "open" : "silent",
        point.answered ?? "",
        point.answeredBy ?? "",
        metres == null ? "" : Math.round(metres),
      ]),
    );
  }
  // A trailing newline, so `wc -l` and `tail` agree with the row count.
  return `${lines.join("\n")}\n`;
}

export const HEARD_COLUMNS = ["time", "type", "from", "beat", "bytes", "lat", "lon", "answered"];

/** The stationary half's record: what arrived, and whether this device replied. */
export function heardToCsv(rows) {
  const lines = [row(HEARD_COLUMNS)];
  for (const entry of rows) {
    lines.push(
      row([
        clock(entry.at),
        entry.type ?? "",
        entry.from ?? "",
        entry.n ?? "",
        entry.bytes ?? "",
        entry.position?.lat ?? "",
        entry.position?.lon ?? "",
        entry.type === "echo" ? "" : entry.answered ? "yes" : "no",
      ]),
    );
  }
  return `${lines.join("\n")}\n`;
}

/** A name that sorts, and says which half of the pair wrote it. */
export function rideFilename(role, at = Date.now()) {
  const stamp = new Date(at).toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return `mesh-heartbeat-${role}-${stamp}.csv`;
}

/** Hand the browser a file. No server anywhere, which is rather the point. */
export function downloadText(filename, text, type = "text/csv;charset=utf-8") {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
