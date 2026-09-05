// SPDX-License-Identifier: GPL-3.0-only
/**
 * The `.ics` file — the one artefact of this whole system that outlives the
 * radio session.
 *
 * Everything else here converges, expires and is recomputed. The calendar
 * entry a customer downloads is different: it lands in Apple Calendar or
 * Thunderbird and has to still be correct months later, on a device that has
 * never heard of LoRa. So this file follows RFC 5545 properly rather than
 * approximately, because the failure mode of "approximately" is a calendar
 * that silently drops the event or shows it an hour out.
 *
 * The three details that are easy to get wrong, and are therefore tested:
 *
 * 1. **Folding is counted in octets, not characters.** A line may not exceed
 *    75 octets, and a multi-byte character may not be split across the fold.
 *    "Föhnen" and "—" are two and three octets; counting characters produces
 *    lines that are legal-looking and too long.
 * 2. **TEXT values escape `\` `;` `,` and newlines** — in that order, or the
 *    backslashes you just inserted get escaped again. An unescaped comma in an
 *    address silently truncates the field.
 * 3. **`UID` is stable and `SEQUENCE` increments.** Same UID on both sides
 *    means the salon and the customer hold *one* event; a rising SEQUENCE means
 *    a changed booking **replaces** the old entry instead of appearing beside
 *    it. Getting this wrong is how a rescheduled appointment becomes two.
 *
 * Times go out in UTC (`…Z`). Storing the instant and rendering it as UTC means
 * never shipping a `VTIMEZONE` block, and never being wrong about a zone the
 * receiving client knows better than we do.
 */

const CRLF = "\r\n";
const MAX_OCTETS = 75;
const encoder = new TextEncoder();

const octets = (text) => encoder.encode(text).length;

/**
 * Fold one content line. Continuation lines begin with a space, and that space
 * counts against the limit — hence 74 octets for every line after the first.
 */
export function foldLine(line) {
  if (octets(line) <= MAX_OCTETS) return line;
  const parts = [];
  let current = "";
  let used = 0;
  let limit = MAX_OCTETS;

  // Iterating the string yields code points, so a character is never split.
  for (const character of line) {
    const size = octets(character);
    if (used + size > limit) {
      parts.push(current);
      current = "";
      used = 0;
      limit = MAX_OCTETS - 1; // the leading space of a continuation line
    }
    current += character;
    used += size;
  }
  parts.push(current);
  return parts.join(`${CRLF} `);
}

/** Escape a TEXT value. Backslashes first, or the escapes escape each other. */
export function escapeText(value) {
  return String(value)
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r\n|\n|\r/g, "\\n");
}

/** `1789...` → `20260910T120000Z`. */
export function toICSDate(epochMs) {
  const at = new Date(epochMs);
  const pad = (n, width = 2) => String(n).padStart(width, "0");
  return (
    `${pad(at.getUTCFullYear(), 4)}${pad(at.getUTCMonth() + 1)}${pad(at.getUTCDate())}` +
    `T${pad(at.getUTCHours())}${pad(at.getUTCMinutes())}${pad(at.getUTCSeconds())}Z`
  );
}

/**
 * Build one calendar file for one booking.
 *
 * @param {Object} booking
 * @param {string} booking.uid Stable for the life of the appointment
 * @param {number} booking.startMs
 * @param {number} booking.endMs
 * @param {string} booking.summary
 * @param {string} [booking.location]
 * @param {string} [booking.url] The change/cancel link — see link.js
 * @param {string} [booking.note] Extra prose above the link
 * @param {number} [booking.sequence] Increment on every change
 * @param {number} [booking.stampMs] DTSTAMP; supply it in tests
 * @param {"PUBLISH"|"CANCEL"} [booking.method]
 * @param {string} [booking.organizer] e.g. `"Salon Funkpost"`
 * @param {string} [booking.attendee] the customer's handle
 * @returns {string} a complete iCalendar object, CRLF-terminated
 */
export function buildICS({
  uid,
  startMs,
  endMs,
  summary,
  location = null,
  url = null,
  note = null,
  sequence = 0,
  stampMs = Date.now(),
  method = "PUBLISH",
  organizer = null,
  attendee = null,
}) {
  if (!uid) throw new Error("an appointment needs a stable UID");
  if (!(endMs > startMs)) throw new Error("an appointment must end after it starts");

  const cancelled = method === "CANCEL";
  const description = [
    cancelled ? "Dieser Termin wurde abgesagt." : note,
    url ? `Termin ändern oder absagen:\n${url}` : null,
    "Gebucht über ein LoRa-Mesh — ohne Server, ohne Internet.",
  ]
    .filter(Boolean)
    .join("\n\n");

  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//funkpost//mesh-appointments//DE",
    "CALSCALE:GREGORIAN",
    `METHOD:${method}`,
    "BEGIN:VEVENT",
    `UID:${uid}`,
    `SEQUENCE:${sequence}`,
    `DTSTAMP:${toICSDate(stampMs)}`,
    `DTSTART:${toICSDate(startMs)}`,
    `DTEND:${toICSDate(endMs)}`,
    `SUMMARY:${escapeText(summary)}`,
    location ? `LOCATION:${escapeText(location)}` : null,
    // Both: many clients show only the notes, some only the URL field.
    url ? `URL:${url}` : null,
    `DESCRIPTION:${escapeText(description)}`,
    organizer ? `ORGANIZER;CN=${escapeText(organizer)}:mailto:noreply@funkpost.invalid` : null,
    attendee ? `ATTENDEE;CN=${escapeText(attendee)}:mailto:noreply@funkpost.invalid` : null,
    `STATUS:${cancelled ? "CANCELLED" : "CONFIRMED"}`,
    "END:VEVENT",
    "END:VCALENDAR",
  ].filter(Boolean);

  return lines.map(foldLine).join(CRLF) + CRLF;
}

/** The filename a browser should offer. Safe on every filesystem. */
export function icsFilename({ summary, startMs }) {
  const stamp = toICSDate(startMs).slice(0, 8);
  const slug = String(summary)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // combining marks, so "Föhnen" → "fohnen"
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
  return `${slug || "termin"}-${stamp}.ics`;
}

/**
 * Unfold and split an iCalendar object back into `[name, value]` pairs.
 *
 * Here so the tests can prove a round trip rather than eyeballing the output,
 * and so the app can read back a file a customer hands it.
 */
export function parseICS(text) {
  const unfolded = text.replace(/\r\n[ \t]/g, "");
  return unfolded
    .split(/\r\n|\n/)
    .filter(Boolean)
    .map((line) => {
      const at = line.indexOf(":");
      if (at < 0) return [line, ""];
      const rawName = line.slice(0, at);
      const value = line.slice(at + 1);
      const name = rawName.split(";")[0];
      return [
        name,
        value.replace(/\\n/g, "\n").replace(/\\,/g, ",").replace(/\\;/g, ";").replace(/\\\\/g, "\\"),
      ];
    });
}

/** The first value for a property name, or null. */
export function icsValue(entries, name) {
  const found = entries.find(([key]) => key === name);
  return found ? found[1] : null;
}
