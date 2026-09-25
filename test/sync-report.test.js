// SPDX-License-Identifier: GPL-3.0-only
/**
 * The line that a delivery joining nothing leaves behind.
 *
 * Before it there was none. A field day on two phones recorded five complete
 * `blocks` arrivals over LoRa and not one join, and the log could not say
 * whether the entries were already here — a courier delivering something the
 * internet had brought first, which is wasteful and correct — or named and
 * never sent, which is a defect. Both produced the same silence, and the run
 * had to be repeated to ask a question the phones were already holding the
 * answer to.
 *
 * So the one thing this has to guarantee: those two cases read differently,
 * in whichever language the phone is set to.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { WORDS } from "../examples/mesh-todo/src/words.js";

const LOCALES = Object.keys(WORDS);

/** A complete delivery whose heads all landed one way or another. */
const report = (over = {}) => ({
  complete: true,
  heads: 1,
  missing: 0,
  joined: 0,
  held: 0,
  absent: 0,
  malformed: 0,
  refused: 0,
  ...over,
});

describe("the applied line", () => {
  test("every language has one", () => {
    // Two locales that disagree about which lines exist is how a phone set to
    // the other language goes quiet in exactly the run worth watching.
    for (const locale of LOCALES) {
      assert.equal(
        typeof WORDS[locale].log.applied,
        "function",
        `${locale} has no applied line`,
      );
    }
    assert.ok(LOCALES.length >= 2, "and there is more than one language to check");
  });

  test("already held and never sent do not read the same", () => {
    for (const locale of LOCALES) {
      const say = WORDS[locale].log.applied;
      const held = say(report({ held: 1 }));
      const absent = say(report({ absent: 1 }));
      assert.notEqual(held, absent, `${locale} cannot tell the two apart`);
      for (const line of [held, absent]) {
        assert.ok(line.length > 0, `${locale} said nothing`);
        assert.match(line, /1/, `${locale} dropped the count`);
      }
    }
  });

  test("a join says so, and says how many of how many", () => {
    for (const locale of LOCALES) {
      const line = WORDS[locale].log.applied(report({ heads: 2, joined: 1, held: 1 }));
      assert.match(line, /2/, `${locale} lost the head count`);
      assert.notEqual(
        line,
        WORDS[locale].log.applied(report({ heads: 2, joined: 2 })),
        `${locale} reads a half-join the same as a whole one`,
      );
    }
  });

  test("an incomplete delivery names what is still missing", () => {
    for (const locale of LOCALES) {
      const line = WORDS[locale].log.applied(
        report({ complete: false, heads: 2, missing: 7 }),
      );
      assert.match(line, /7/, `${locale} did not say how many blocks are missing`);
      assert.notEqual(
        line,
        WORDS[locale].log.applied(report({ heads: 2 })),
        `${locale} reads an incomplete delivery as a complete one`,
      );
    }
  });

  test("a delivery that came to nothing at all still leaves a line", () => {
    // The degenerate case — no heads offered — is the one most likely to slip
    // back into silence, and silence is the bug this exists to end.
    for (const locale of LOCALES) {
      const line = WORDS[locale].log.applied(report({ heads: 0 }));
      assert.ok(line.trim().length > 1, `${locale} went quiet on an empty delivery`);
    }
  });
});
