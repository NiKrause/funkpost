// SPDX-License-Identifier: GPL-3.0-only
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as Y from "yjs";
import {
  buildICS,
  foldLine,
  escapeText,
  toICSDate,
  parseICS,
  icsValue,
  icsFilename,
} from "../src/domain/ics.js";
import { bookingLink, parseBookingLink, shopLink, parseShopLink, DEFAULT_BASE } from "../src/domain/link.js";
import { newToken, TOKEN_BYTES } from "../src/domain/capability.js";
import { createBookingBook } from "../src/domain/booking.js";
import { createClaimLog } from "../src/domain/claimlog.js";
import { CONFIRMED, DECLINED } from "../src/domain/arbitration.js";

const MONDAY = "2026-09-07";
const DAYS = 21;

/** Rules in Yjs, bookings in a claim log — see docs/mesh-calendar.md. */
const makeBook = async (patch = {}) => {
  const book = createBookingBook({ doc: new Y.Doc(), log: createClaimLog() });
  const salonToken = await book.becomeSalon();
  if (Object.keys(patch).length) book.setShop(patch);
  return { book, salonToken };
};
const ask = (extra) => ({ fromISO: MONDAY, days: DAYS, ...extra });
const octets = (text) => new TextEncoder().encode(text).length;

const contentLines = (ics) => ics.split("\r\n").filter(Boolean);

describe("ics — the details that break real calendars", () => {
  test("no content line exceeds 75 octets, counted as octets", () => {
    const ics = buildICS({
      uid: "bk1@funkpost",
      startMs: Date.UTC(2026, 8, 10, 12, 0),
      endMs: Date.UTC(2026, 8, 10, 12, 45),
      summary: "Färben, Föhnen & Schnitt — Salon Funkpost am Marktplatz",
      location: "Marktplatz 3, Eggenfelden, Niederbayern",
      url: `${DEFAULT_BASE}#/b/salon-funkpost/AAAAAAAAAAA/${"x".repeat(43)}`,
      stampMs: Date.UTC(2026, 8, 5, 8, 0),
    });

    for (const line of contentLines(ics)) {
      assert.ok(octets(line) <= 75, `${octets(line)} octets: ${line}`);
    }
  });

  test("a multi-byte character is never split across the fold", () => {
    // Every character is three octets, so a character-counting implementation
    // folds in exactly the wrong places.
    const line = `DESCRIPTION:${"—".repeat(60)}`;
    const folded = foldLine(line);
    for (const part of folded.split("\r\n")) {
      assert.ok(octets(part) <= 75, `${octets(part)} octets`);
    }
    // Unfolding must give back precisely what went in — no mangled bytes.
    assert.equal(folded.replace(/\r\n /g, ""), line);
  });

  test("escapes backslash, semicolon, comma and newline — in that order", () => {
    assert.equal(escapeText("a,b;c\\d\ne"), "a\\,b\\;c\\\\d\\ne");
    // The trap: escaping commas before backslashes would double-escape them.
    assert.equal(escapeText("\\,"), "\\\\\\,");
  });

  test("an unescaped comma would have truncated the address", () => {
    const ics = buildICS({
      uid: "bk1@funkpost",
      startMs: Date.UTC(2026, 8, 10, 12, 0),
      endMs: Date.UTC(2026, 8, 10, 12, 45),
      summary: "Schnitt",
      location: "Marktplatz 3, Eggenfelden",
      stampMs: 0,
    });
    assert.match(ics, /LOCATION:Marktplatz 3\\, Eggenfelden/);
    assert.equal(icsValue(parseICS(ics), "LOCATION"), "Marktplatz 3, Eggenfelden");
  });

  test("round-trips through a parser: what goes in comes back out", () => {
    const url = bookingLink({
      shopId: "salon-funkpost",
      bookingId: "abcd1234",
      token: new Uint8Array(TOKEN_BYTES).fill(9),
    });
    const ics = buildICS({
      uid: "bk1@funkpost",
      startMs: Date.UTC(2026, 8, 10, 12, 0),
      endMs: Date.UTC(2026, 8, 10, 12, 45),
      summary: "Haarschnitt & Föhnen — Salon Funkpost",
      location: "Marktplatz 3, Eggenfelden",
      url,
      stampMs: Date.UTC(2026, 8, 5, 8, 0),
    });
    const entries = parseICS(ics);

    assert.equal(icsValue(entries, "VERSION"), "2.0");
    assert.equal(icsValue(entries, "UID"), "bk1@funkpost");
    assert.equal(icsValue(entries, "SUMMARY"), "Haarschnitt & Föhnen — Salon Funkpost");
    assert.equal(icsValue(entries, "DTSTART"), "20260910T120000Z");
    assert.equal(icsValue(entries, "DTEND"), "20260910T124500Z");
    assert.equal(icsValue(entries, "STATUS"), "CONFIRMED");
    assert.equal(icsValue(entries, "URL"), url, "the link survives folding intact");
    assert.match(icsValue(entries, "DESCRIPTION"), /Termin ändern oder absagen/);
    assert.ok(icsValue(entries, "DESCRIPTION").includes(url));
  });

  test("is structurally a calendar: CRLF, one VEVENT, required properties", () => {
    const ics = buildICS({
      uid: "u@funkpost",
      startMs: Date.UTC(2026, 8, 10, 12, 0),
      endMs: Date.UTC(2026, 8, 10, 12, 30),
      summary: "Schnitt",
      stampMs: 0,
    });
    assert.ok(ics.endsWith("\r\n"));
    assert.ok(!/[^\r]\n/.test(ics), "every break must be CRLF");
    const names = parseICS(ics).map(([n]) => n);
    assert.deepEqual(names.slice(0, 2), ["BEGIN", "VERSION"]);
    assert.equal(names.filter((n) => n === "BEGIN").length, 2);
    assert.equal(names.filter((n) => n === "END").length, 2);
    for (const required of ["UID", "DTSTAMP", "DTSTART", "DTEND", "SUMMARY", "SEQUENCE"]) {
      assert.ok(names.includes(required), `missing ${required}`);
    }
  });

  test("times are UTC, so no VTIMEZONE is ever needed", () => {
    assert.equal(toICSDate(Date.UTC(2026, 0, 1, 0, 0, 0)), "20260101T000000Z");
    assert.equal(toICSDate(Date.UTC(2026, 11, 31, 23, 59, 59)), "20261231T235959Z");
    const ics = buildICS({
      uid: "u@funkpost",
      startMs: Date.UTC(2026, 8, 10, 12, 0),
      endMs: Date.UTC(2026, 8, 10, 12, 30),
      summary: "Schnitt",
      stampMs: 0,
    });
    assert.ok(!ics.includes("VTIMEZONE"));
    assert.ok(!ics.includes("TZID"));
  });

  test("refuses nonsense rather than emitting a broken file", () => {
    const base = { uid: "u", startMs: 1000, endMs: 2000, summary: "x" };
    assert.throws(() => buildICS({ ...base, uid: "" }), /stable UID/);
    assert.throws(() => buildICS({ ...base, endMs: 1000 }), /end after it starts/);
    assert.throws(() => buildICS({ ...base, endMs: 500 }), /end after it starts/);
  });

  test("offers a filename a filesystem will accept", () => {
    assert.equal(
      icsFilename({ summary: "Haarschnitt & Föhnen", startMs: Date.UTC(2026, 8, 10, 12, 0) }),
      "haarschnitt-fohnen-20260910.ics",
    );
    assert.equal(icsFilename({ summary: "•••", startMs: Date.UTC(2026, 8, 10) }), "termin-20260910.ics");
  });
});

describe("ics — replacing an appointment instead of duplicating it", () => {
  const common = {
    uid: "bk1@funkpost",
    startMs: Date.UTC(2026, 8, 10, 12, 0),
    endMs: Date.UTC(2026, 8, 10, 12, 45),
    summary: "Schnitt",
    stampMs: 0,
  };

  test("same UID, rising SEQUENCE — the calendar replaces the old entry", () => {
    const first = parseICS(buildICS({ ...common, sequence: 0 }));
    const changed = parseICS(buildICS({ ...common, sequence: 1, startMs: Date.UTC(2026, 8, 10, 14, 0), endMs: Date.UTC(2026, 8, 10, 14, 45) }));

    assert.equal(icsValue(first, "UID"), icsValue(changed, "UID"), "one event, not two");
    assert.ok(Number(icsValue(changed, "SEQUENCE")) > Number(icsValue(first, "SEQUENCE")));
    assert.equal(icsValue(changed, "DTSTART"), "20260910T140000Z");
  });

  test("a cancellation says CANCEL and CANCELLED, and says so in the notes", () => {
    const entries = parseICS(buildICS({ ...common, sequence: 2, method: "CANCEL" }));
    assert.equal(icsValue(entries, "METHOD"), "CANCEL");
    assert.equal(icsValue(entries, "STATUS"), "CANCELLED");
    assert.match(icsValue(entries, "DESCRIPTION"), /abgesagt/);
  });
});

describe("the serverless link", () => {
  test("the capability lives in the fragment, which never reaches a server", () => {
    const token = newToken();
    const url = bookingLink({ shopId: "salon-funkpost", bookingId: "abcd1234", token });

    const [beforeHash, fragment] = url.split("#");
    assert.ok(beforeHash.endsWith("/termine/"), "the path is static files only");
    assert.ok(!beforeHash.includes("?"), "nothing in a query string, ever");
    // The token appears only after the '#'.
    assert.ok(!beforeHash.includes(fragment.split("/").pop()));
  });

  test("round-trips a full URL and a bare fragment alike", () => {
    const token = newToken();
    const url = bookingLink({ shopId: "salon", bookingId: "abcd1234", token });
    for (const input of [url, `#${url.split("#")[1]}`, url.split("#")[1]]) {
      const parsed = parseBookingLink(input);
      assert.ok(parsed, `failed to parse: ${input}`);
      assert.equal(parsed.shopId, "salon");
      assert.equal(parsed.bookingId, "abcd1234");
      assert.deepEqual([...parsed.token], [...token]);
    }
  });

  test("returns null for anything malformed rather than throwing", () => {
    // This parses whatever a calendar app or a QR scanner hands over.
    for (const bad of [
      "",
      null,
      undefined,
      42,
      "https://example.com/",
      "#/b/salon",
      "#/b/salon/id",
      "#/x/salon/id/AAAA",
      "#/b/salon/id/not-base64-and-too-short",
      `#/b/sa lon/id/${"A".repeat(43)}`,
    ]) {
      assert.equal(parseBookingLink(bad), null, `should not have parsed: ${bad}`);
    }
  });

  test("rejects a token of the wrong length — a truncated paste is not a key", () => {
    assert.throws(
      () => bookingLink({ shopId: "s", bookingId: "b", token: new Uint8Array(16) }),
      /32 bytes/,
    );
    assert.equal(parseBookingLink("#/b/s/b/QUJD"), null, "3 bytes is not a token");
  });

  test("refuses ids that would not survive a URL", () => {
    const token = newToken();
    assert.throws(() => bookingLink({ shopId: "salon/../etc", bookingId: "b", token }), /URL-safe/);
    assert.throws(() => bookingLink({ shopId: "s", bookingId: "a b", token }), /URL-safe/);
  });

  test("the counter link carries no capability at all", () => {
    const url = shopLink({ shopId: "salon-funkpost" });
    assert.equal(url, `${DEFAULT_BASE}#/s/salon-funkpost`);
    assert.deepEqual(parseShopLink(url), { shopId: "salon-funkpost" });
    assert.equal(parseBookingLink(url), null, "a shop link must not read as a booking link");
  });
});

describe("the gate: a real booking becomes a real file", () => {
  test("the customer's file carries the link; the salon's does not", async () => {
    const { book } = await makeBook();
    const { id, token } = await book.request(ask({ slotIndex: 20, serviceId: "cut", handle: "Nico", at: 1_000 }));

    const customer = await book.icsFor(id, { fromISO: MONDAY, days: DAYS, token, shopId: "salon-funkpost", stampMs: 0 });
    const salon = await book.icsFor(id, { fromISO: MONDAY, days: DAYS, role: "salon", stampMs: 0 });

    const c = parseICS(customer.text);
    const s = parseICS(salon.text);

    assert.equal(icsValue(c, "UID"), icsValue(s, "UID"), "both hold one event");
    assert.equal(icsValue(c, "DTSTART"), icsValue(s, "DTSTART"));

    const link = icsValue(c, "URL");
    assert.ok(link, "the customer can change the booking");
    assert.deepEqual([...parseBookingLink(link).token], [...token]);
    assert.equal(parseBookingLink(link).bookingId, id);

    assert.equal(icsValue(s, "URL"), null, "the salon holds no capability, so offers no link");
    assert.match(icsValue(s, "DESCRIPTION"), /Nico/, "the salon's copy names the customer");
    assert.ok(!icsValue(c, "DESCRIPTION").includes("Kundin"), "the customer's copy does not");

    // 14:00 on the Monday, 45 minutes, as the grid says.
    const grid = book.grid(MONDAY, DAYS);
    assert.equal(icsValue(c, "DTSTART"), toICSDate(grid[20].startMs));
    assert.equal(icsValue(c, "DTEND"), toICSDate(grid[20].startMs + 45 * 60_000));
    assert.equal(customer.filename, `haarschnitt-fohnen-${toICSDate(grid[20].startMs).slice(0, 8)}.ics`);
  });

  test("a cancellation re-issues the same event, replacing it", async () => {
    const { book } = await makeBook();
    const { id, token } = await book.request(ask({ slotIndex: 12, serviceId: "trim", handle: "Anna", at: 1 }));

    const before = await book.icsFor(id, { fromISO: MONDAY, days: DAYS, token, stampMs: 0 });
    assert.equal(before.sequence, 0);
    assert.equal(icsValue(parseICS(before.text), "METHOD"), "PUBLISH");

    await book.cancel(id, token, { at: 2 });
    const after = await book.icsFor(id, { fromISO: MONDAY, days: DAYS, token, stampMs: 0 });

    assert.equal(after.sequence, 1, "the change is counted, so calendars replace");
    assert.ok(after.cancelled);
    const entries = parseICS(after.text);
    assert.equal(icsValue(entries, "METHOD"), "CANCEL");
    assert.equal(icsValue(entries, "STATUS"), "CANCELLED");
    assert.equal(icsValue(entries, "UID"), icsValue(parseICS(before.text), "UID"));
  });

  test("a declined request produces a CANCEL, not a confirmation", async () => {
    const { book, salonToken } = await makeBook({ mode: "ask" });
    const { id, token } = await book.request(ask({ slotIndex: 12, serviceId: "trim", handle: "Anna", at: 1 }));
    await book.decide(id, DECLINED, { salonToken, at: 2, note: "leider voll" });

    const file = await book.icsFor(id, { fromISO: MONDAY, days: DAYS, token, stampMs: 0 });
    assert.ok(file.cancelled);
    assert.equal(icsValue(parseICS(file.text), "STATUS"), "CANCELLED");
  });

  test("a confirmed request in ask mode publishes normally", async () => {
    const { book, salonToken } = await makeBook({ mode: "ask" });
    const { id, token } = await book.request(ask({ slotIndex: 12, serviceId: "trim", handle: "Anna", at: 1 }));
    await book.decide(id, CONFIRMED, { salonToken, at: 2 });

    const file = await book.icsFor(id, { fromISO: MONDAY, days: DAYS, token, stampMs: 0 });
    assert.ok(!file.cancelled);
    assert.equal(file.sequence, 1);
    assert.equal(icsValue(parseICS(file.text), "STATUS"), "CONFIRMED");
  });

  test("refuses a booking outside the horizon rather than inventing a time", async () => {
    const { book } = await makeBook();
    // A slot index the horizon does not contain is refused at request time now:
    // a booking carries an absolute start, so there is no invalid one to store.
    await assert.rejects(
      () => book.request(ask({ slotIndex: 99_999, serviceId: "trim", handle: "X", at: 1 })),
      /outside the horizon/,
    );
    await assert.rejects(() => book.icsFor("nope", { fromISO: MONDAY, days: DAYS }), /no such booking/);
  });
});
