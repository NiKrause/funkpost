// SPDX-License-Identifier: GPL-3.0-only
/**
 * Who actually got the slot.
 *
 * Yjs will happily merge two bookings for 14:00. Both replicas end up
 * byte-identical and **double-booked** — the CRDT has not solved the conflict,
 * it has only made everyone agree that it exists. Convergence is not agreement.
 *
 * The answer is a *pure function of the converged state*: every replica sorts
 * the same claims by the same key and reaches the same verdict on its own.
 * Nothing is written to resolve a race, so resolving one cannot start another
 * — and no packet crosses the air to do it, which on a duty-cycled link is the
 * difference between a design that works and one that only works in the demo.
 *
 * The two modes differ in *what outranks what*, and that difference is the
 * whole argument for offering both:
 *
 * - **auto** — nobody decides, so time decides: earliest claim wins, and a
 *   loser learns it the moment the two writes meet (which may be late, if the
 *   two customers could not hear each other).
 * - **ask** — the salon decides, so a confirmed booking outranks any pending
 *   one regardless of who asked first. Pending requests do **not** block each
 *   other; a double-booking is impossible because only the salon writes
 *   confirmations.
 */

/** A booking that holds its slot. */
export const CONFIRMED = "confirmed";
/** Waiting for the salon (ask mode only). */
export const PENDING = "pending";
/** The salon said no. */
export const DECLINED = "declined";
/** Withdrawn by whoever held the capability key. */
export const CANCELLED = "cancelled";
/** Someone else got this time first — nobody wrote this, it was computed. */
export const SUPERSEDED = "superseded";

/**
 * Total order over claims. Deliberately total: a tie on the timestamp still
 * has to break the same way on every device, so the id decides — arbitrary,
 * but identical everywhere, which is the only property that matters.
 *
 * Clock skew between two phones changes *which* of two near-simultaneous
 * claims wins. It never changes *whether* the two agree.
 */
const byClaim = (a, b) => a.claimedAt - b.claimedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

// The decision's own timestamp, which lives on the decision rather than on the
// claim — reading it off the claim silently compares two undefineds and falls
// through to the id, which is deterministic but the wrong policy.
const byDecision = (a, b) =>
  (a.decision?.decidedAt ?? 0) - (b.decision?.decidedAt ?? 0) ||
  (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

const spanOf = (request) => {
  const start = request.slotIndex;
  return [start, start + Math.max(1, request.steps ?? 1)];
};

const overlaps = ([aStart, aEnd], [bStart, bEnd]) => aStart < bEnd && bStart < aEnd;

/**
 * Decide the state of every booking in a converged document.
 *
 * @param {Object} input
 * @param {"auto"|"ask"} input.mode
 * @param {Iterable<Object>} input.requests `{ id, slotIndex, steps, claimedAt, … }`
 * @param {Map<string, Object>|Object} [input.decisions] id → `{ status, decidedAt }`
 * @param {Map<string, Object>|Object} [input.cancels] id → `{ at }` — **already
 *   signature-checked**; arbitration trusts what it is handed
 * @returns {Map<string, { status: string, reason: string|null }>}
 */
export function arbitrate({ mode = "auto", requests, decisions = new Map(), cancels = new Map() }) {
  // Duck-typed on purpose: a `Y.Map` is NOT an `instanceof Map`, so testing for
  // one silently reads nothing at all — and because auto mode never consults
  // decisions, the failure hides until someone switches the salon to Rückfrage.
  const get = (source, id) => {
    if (!source) return undefined;
    if (typeof source.get === "function") return source.get(id);
    return Object.prototype.hasOwnProperty.call(source, id) ? source[id] : undefined;
  };

  const all = [...requests];
  const verdict = new Map();
  const eligible = [];

  for (const request of all) {
    if (get(cancels, request.id)) {
      verdict.set(request.id, { status: CANCELLED, reason: null });
      continue;
    }
    const decision = get(decisions, request.id);
    if (decision?.status === DECLINED) {
      verdict.set(request.id, { status: DECLINED, reason: decision.note ?? null });
      continue;
    }
    eligible.push({ ...request, decision });
  }

  // Occupied index ranges, in the order they were awarded.
  const taken = [];
  const award = (claim, status) => {
    taken.push(spanOf(claim));
    verdict.set(claim.id, { status, reason: null });
  };
  const conflicts = (claim) => taken.some((span) => overlaps(span, spanOf(claim)));

  if (mode === "ask") {
    // The salon's word first, in the order the salon gave it. Two confirmations
    // for one time can only happen if the salon ran on two devices at once —
    // deterministic tie-break rather than a crash.
    const confirmed = eligible.filter((c) => c.decision?.status === CONFIRMED).sort(byDecision);
    for (const claim of confirmed) {
      if (conflicts(claim)) verdict.set(claim.id, { status: SUPERSEDED, reason: "slot already confirmed" });
      else award(claim, CONFIRMED);
    }
    // Then the undecided. They do not occupy anything: two people may wait on
    // the same time, and the salon picks. Blocking here would let an abandoned
    // request hold a slot for ever.
    for (const claim of eligible.filter((c) => !c.decision).sort(byClaim)) {
      if (conflicts(claim)) verdict.set(claim.id, { status: SUPERSEDED, reason: "slot taken while you waited" });
      else verdict.set(claim.id, { status: PENDING, reason: null });
    }
    return verdict;
  }

  // auto: nobody decides, so time does.
  for (const claim of eligible.sort(byClaim)) {
    if (conflicts(claim)) verdict.set(claim.id, { status: SUPERSEDED, reason: "someone booked it first" });
    else award(claim, CONFIRMED);
  }
  return verdict;
}

/** Grid indices held by bookings that actually stand — what the mask marks. */
export function busyIndices(requests, verdict) {
  const busy = new Set();
  for (const request of requests) {
    const status = verdict.get(request.id)?.status;
    if (status !== CONFIRMED && status !== PENDING) continue;
    const [start, end] = spanOf(request);
    for (let i = start; i < end; i++) busy.add(i);
  }
  return busy;
}
