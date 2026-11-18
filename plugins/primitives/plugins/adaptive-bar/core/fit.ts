/**
 * The adaptive bar's fit math: given a width and a ladder of forms per item,
 * decide which rung each item renders at and which items leave the row.
 *
 * Pure on purpose — no DOM, no React. The browser half measures and relocates;
 * every *decision* is made here, so it can be exercised without a layout engine.
 *
 * Design: <../../../../../research/2026-08-16-global-adaptive-bar-relocating-overflow.md>
 * (§ "Measurement and fit").
 */

import { isBarred, type BlockedRungs } from "./blocked-rungs";

/** One item's participation in the row. */
export interface FitItem {
  id: string;
  /**
   * Inline widths per rung, **widest first** (rung 0 is the widest form the
   * widget can render). `undefined` = that rung has never been measured.
   *
   * One rung per form the occupant is actually OFFERED, which is not the same as
   * the forms it declared: a rung the occupant has been observed to render
   * nothing at is not a rung the bar may put it on, so the driver cuts the
   * declared ladder short there (`core/absent-rungs.ts`).
   *
   * **Length ≥ 1, and by construction rather than by convention.** An occupant
   * whose ladder cuts to nothing renders nothing at every form the bar could
   * hand it — it has a host and a 0×0 container, but it is not an occupant, so
   * it never reaches the fit at all. That decision is made in exactly ONE place,
   * where the cut is computed (`reconcile`'s item construction), and nothing
   * here repeats it. There is deliberately no `absent` flag beside this array
   * either: a flag can disagree with the ladder, and an occupant that is both
   * "absent" and "has a rung 0 it renders content at" is exactly the state that
   * made the bar flip between the two for ever.
   *
   * The array is monotone by construction: a narrower rung is never wider than
   * a wider one. `assign` relies on that to bound an unmeasured rung from a
   * measured wider one — see {@link resolveWidth}.
   */
  inlineWidths: readonly (number | undefined)[];
  /** Can this item leave the row entirely (relocate to a panel, or be clipped)? */
  evictable: boolean;
  /**
   * Yield order. **Higher yields sooner**: the highest-ranked item is demoted
   * first, so a widget that declared itself eager outranks a normal one, and a
   * widget that declared `"never"` gets the lowest rank and is the last thing
   * the bar touches.
   */
  yieldRank: number;
  /**
   * Frozen at `currentRung` — a live drag or an open popup.
   *
   * Frozen at the rung it can legally occupy, which is not always the one it is
   * on: `clampCurrent` still applies, so an item pinned at a rung its ladder no
   * longer reaches (the widget stopped rendering that form, and the cut moved
   * the ladder out from under it) is seated at the nearest rung it does reach.
   * A pin protects an interaction from being MOVED; it cannot hold a widget
   * somewhere it renders nothing, which would freeze it into invisibility.
   */
  pinned?: boolean;
  /** Current rung index, or `null` if currently evicted. */
  currentRung: number | null;
  /**
   * The cohort this item leaves the row with (`ShrinkLadder.cohort`), or
   * `null`: once any member is evicted, every evictable, unpinned member is.
   */
  cohort?: string | null;
  /**
   * How many forms the widget DECLARED, which is ≥ `inlineWidths.length`.
   *
   * Read by {@link passBudget} alone — never by `assign`, which may only ever
   * place an item at a rung it is offered. The difference between the two counts
   * is what the search had to *discover*: each cut cost it a round, exactly as a
   * demotion does, so a budget derived from the offered ladder alone would
   * shrink by the very rounds it is meant to be paying for.
   */
  declaredRungs: number;
}

export interface FitInput {
  available: number;
  gap: number;
  /** Width reserved when ≥1 item is evicted. 0 when the host shows no trigger. */
  triggerPx: number;
  hysteresisPx: number;
  items: readonly FitItem[];
  /**
   * Rungs an item may not re-enter until the row is wider — H2. The rule (per
   * rung, widest width wins, and a rejection at one rung implies one at every
   * wider rung) lives in `./blocked-rungs`.
   */
  blocked?: BlockedRungs;
}

export interface FitResult {
  /**
   * id → rung index, or `null` for evicted. **Total over `items`** — every item
   * handed in gets an entry, so a caller reading this map back can treat a
   * missing id as exactly one thing: an id this decision never saw.
   */
  placement: ReadonlyMap<string, number | null>;
  /** True when any width used in the decision was an estimate rather than a measurement. */
  usedEstimate: boolean;
  /**
   * Does the returned placement actually fit? `false` means the row is at its
   * floor and still overflows (or a width is unknown and no bound exists), so
   * the host must clip / scroll rather than believe the layout. Paired with
   * {@link FitResult.usedEstimate} this is the difference between "fits" and
   * "probably fits" — never collapse the two into a bare boolean.
   */
  fits: boolean;
  /**
   * Demotions performed. Diagnostic only, but load-bearing for the termination
   * proof: it is bounded by Σ stepsRemaining, so a test can assert the loop
   * cannot run away rather than trusting the argument.
   */
  iterations: number;
}

/** Never fewer rounds than the constant this replaced, so no row gets a smaller budget than before. */
const MIN_PASS_BUDGET = 4;
/**
 * And never more than this. Every round costs at least one nested synchronous
 * React update, and React's own limit is 50 — so the budget has to stay clear of
 * it by a margin, or a slow search becomes a dead pane instead of a warning.
 */
const MAX_PASS_BUDGET = 16;

/**
 * How many placement-changing rounds one search may legitimately need, derived
 * from the row it is searching rather than fixed.
 *
 * The quantity is **the total number of steps this row has to give**: each item
 * can be demoted through the rungs its widget declared and then, if it may, out
 * of the row altogether. Declared rather than offered, because a rung the bar
 * has since stopped offering is not a step the row lost — it is a step the
 * search spent a round DISCOVERING, and a budget that shrank as it learned would
 * charge that round twice.
 *
 * A round does not necessarily spend one step per item — the
 * **one estimated step per pass** rule (see {@link Placed.spentEstimatedStep})
 * caps each item at one *unmeasured* step per call, and the widths an item
 * reveals by moving can change what its neighbours need — so the honest bound is
 * the sum, plus one round for a ladder that arrives late (`useActionForm`
 * declares on a passive effect, so the first round or two of a cold start runs
 * with the default one-rung ladder) and one for the round that re-derives the
 * same answer and thereby converges.
 *
 * Deliberately not a constant. The constant it replaces (`MAX_PASSES = 4`)
 * carried a docstring naming the ladder depth, but ladder depth is 2 for every
 * bar in this repo — so it was really a fixed 4 with no stated derivation and,
 * as it turned out, no margin: a cold start on a real row costs 2 rounds, a late
 * ladder a third and hysteresis a fourth, and the fifth was a filed fault.
 */
export function passBudget(items: readonly FitItem[]): number {
  let steps = 0;
  for (const item of items) {
    steps += item.declaredRungs - 1 + (item.evictable ? 1 : 0);
  }
  return Math.min(MAX_PASS_BUDGET, Math.max(MIN_PASS_BUDGET, steps + 2));
}

/**
 * How confidently we know an item's width at one rung.
 *
 * `bounded` is the monotone bound: the rung itself was never measured, but a
 * *wider* rung was, and a narrower form is never wider than a wider one — so
 * that measurement is an upper bound. An upper bound can only make the row look
 * too wide, i.e. it can refuse a fit but never fabricate one, which is exactly
 * the guarantee we need from an estimate.
 *
 * `unbounded` is the dangerous case: nothing is known at this rung or any wider
 * one, so there is no upper bound at all. Substituting 0 there *would* fabricate
 * a fit, so a configuration containing one is reported as not fitting.
 */
type ResolvedWidth =
  | { kind: "exact"; px: number }
  | { kind: "bounded"; px: number }
  | { kind: "unbounded" };

function resolveWidth(
  widths: readonly (number | undefined)[],
  rung: number,
): ResolvedWidth {
  const own = widths[rung];
  if (own !== undefined) return { kind: "exact", px: own };
  // Only *wider* rungs (lower indices) bound this one. A narrower rung is a
  // lower bound, and a lower bound is precisely what would fabricate a fit.
  for (let j = rung - 1; j >= 0; j--) {
    const w = widths[j];
    if (w !== undefined) return { kind: "bounded", px: w };
  }
  return { kind: "unbounded" };
}

/** Mutable per-item state during the search. */
interface Placed {
  readonly item: FitItem;
  readonly index: number;
  /**
   * False until the item has been placed once. The aggregates below are updated
   * by difference, so the very first placement must not subtract a contribution
   * that was never added.
   */
  seated: boolean;
  /** Current rung, or `null` for evicted. */
  rung: number | null;
  /** What this item currently adds to `sum` (0 when evicted or unbounded). */
  contributed: number;
  /** Whether the currently-counted width is an estimate, and of which flavour. */
  contributedKind: ResolvedWidth["kind"] | "none";
  /**
   * Set once the item has stepped INTO a rung whose width is an estimate.
   *
   * "Never skip a rung while estimating": the estimate for rung k+1 is the
   * width of rung k, so a chain of demotions driven by estimates would relocate
   * an item that compaction alone would have saved — and we would never learn
   * otherwise, because only inline nodes are measurable. Capping the item at one
   * estimated step costs one extra pass and makes that unlearnable state
   * unreachable.
   */
  spentEstimatedStep: boolean;
}

/**
 * Assign every item a rung (or eviction) for the given width.
 *
 * The search starts every unpinned item at its widest allowed rung and only ever
 * demotes, so the answer is a function of `available` and the widths — not of
 * where the items happen to be right now. `currentRung` is read for exactly two
 * things: freezing a `pinned` item, and the H1 promote band below.
 */
export function assign(input: FitInput): FitResult {
  const { available, gap, triggerPx, hysteresisPx, items, blocked } = input;

  // Every item handed in is an occupant, and every occupant gets an entry in the
  // placement below. A contribution that renders nothing at every form it was
  // offered is not an occupant and never arrives here — see
  // `FitItem.inlineWidths`, and the one place that decides it.
  const states: Placed[] = items.map((item, index) => ({
    item,
    index,
    seated: false,
    rung: null,
    contributed: 0,
    contributedKind: "none",
    spentEstimatedStep: false,
  }));

  // ── Running aggregates ────────────────────────────────────────────────────
  // The total is maintained incrementally: every demotion is an O(1) update of
  // these counters, never a re-sum over the row. Re-summing per candidate is
  // what turns an O(n) pass into an O(n²) one.
  let sum = 0;
  let inlineCount = 0;
  let evictedCount = 0;
  let unboundedCount = 0;
  let usedEstimate = false;

  const total = (): number => {
    // The trigger is one more element in the row, so it pays for one more gap —
    // and it is reserved exactly once no matter how many items are evicted.
    const elements = inlineCount + (evictedCount > 0 ? 1 : 0);
    return (
      sum + (evictedCount > 0 ? triggerPx : 0) + gap * Math.max(0, elements - 1)
    );
  };

  const doesFit = (): boolean => unboundedCount === 0 && total() <= available;

  /** Move `p` to `rung` (or `null`), keeping the aggregates in step. */
  const place = (p: Placed, rung: number | null): void => {
    if (p.seated) {
      if (p.rung !== null) {
        sum -= p.contributed;
        inlineCount -= 1;
        if (p.contributedKind === "unbounded") unboundedCount -= 1;
      } else {
        evictedCount -= 1;
      }
    }
    p.seated = true;

    p.rung = rung;
    if (rung === null) {
      p.contributed = 0;
      p.contributedKind = "none";
      evictedCount += 1;
      return;
    }

    const w = resolveWidth(p.item.inlineWidths, rung);
    p.contributedKind = w.kind;
    p.contributed = w.kind === "unbounded" ? 0 : w.px;
    sum += p.contributed;
    inlineCount += 1;
    if (w.kind === "unbounded") unboundedCount += 1;
    // Sticky: the flag answers "was an estimate used in this decision", which
    // includes an estimate that only ever appeared in a rejected candidate.
    if (w.kind !== "exact") usedEstimate = true;
  };

  const rungCount = (p: Placed): number => p.item.inlineWidths.length;

  // H2 in one line: the ledger owns the rule, including the monotone
  // implication that makes a bar on a narrow rung also a bar on every wider
  // one. See `./blocked-rungs`.
  const isBlocked = (p: Placed, rung: number): boolean =>
    blocked !== undefined &&
    isBarred(blocked, p.item.id, rung, available, hysteresisPx);

  /** The next rung at or after `from` that H2 allows, or `null` if none. */
  const nextAllowedFrom = (p: Placed, from: number): number | null => {
    for (let r = from; r < rungCount(p); r++) {
      if (!isBlocked(p, r)) return r;
    }
    return null;
  };

  /** The state one demotion step below `p`'s current one, or `null` if it is at its floor. */
  const nextState = (p: Placed): { rung: number | null } | null => {
    if (p.rung === null) return null; // evicted is the floor
    const next = nextAllowedFrom(p, p.rung + 1);
    if (next !== null) return { rung: next };
    return p.item.evictable ? { rung: null } : null;
  };

  // Seed: widest allowed rung for everyone unpinned; pinned items are frozen
  // wherever they are, because moving a widget mid-drag or mid-popover destroys
  // the interaction the freeze exists to protect.
  const frozen = new Set<string>();
  for (const p of states) {
    if (p.item.pinned === true) {
      frozen.add(p.item.id);
      place(p, clampCurrent(p.item));
      continue;
    }
    const start = nextAllowedFrom(p, 0);
    if (start !== null) {
      place(p, start);
    } else if (p.item.evictable) {
      // Every rung is barred and the item can leave — the panel is its only
      // legal state.
      place(p, null);
    } else {
      // Every rung is barred and the item cannot leave. Something must render,
      // so the bar is ignored rather than the widget disappearing: a stale H2
      // entry must never be able to unmount a mandatory control.
      place(p, 0);
    }
  }

  // Demotion order: highest yieldRank first, ties broken by the LATER item in
  // `items` order (the tail of a bar is conventionally the least important).
  //
  // One sort plus one advancing cursor, never a rescan: demotability is
  // monotone — an item that has reached its floor or spent its estimated step
  // never becomes demotable again within a call — so once the cursor passes an
  // item it never has to come back. That is what keeps this O(n log n) instead
  // of an O(n²) "scan for the best candidate" loop.
  const order = states
    .filter((p) => !frozen.has(p.item.id))
    .sort((a, b) => b.item.yieldRank - a.item.yieldRank || b.index - a.index);

  /**
   * An item we cannot size is an item we must not move.
   *
   * `unbounded` means nothing is known about this item at this rung or any wider
   * one, so it contributes 0 to `sum` — demoting it cannot reduce a total it was
   * never counted in, and evicting it makes the ignorance PERMANENT: only an
   * inline node is measurable, so an item in the panel can never teach the
   * ledger what it costs.
   *
   * That is not a hypothetical. `staleOthers` downgrades an item's other rungs
   * the moment its current one measures differently, so an occupant sitting at
   * its compact rung whose content changes leaves rung 0 unmeasured-and-
   * unbounded. Without this clause the very next fit seeds it there, `doesFit`
   * is false forever, every evictable occupant goes to the panel, the placement
   * is stable — so the bar CONVERGES on the floor, files nothing, and can never
   * find its way back. Keeping the item inline costs one cramped pass and the
   * next one measures it.
   */
  const isDemotable = (p: Placed): boolean =>
    !p.spentEstimatedStep &&
    p.contributedKind !== "unbounded" &&
    nextState(p) !== null;

  let iterations = 0;
  let cursor = 0;
  while (!doesFit()) {
    while (cursor < order.length && !isDemotable(order[cursor]!)) cursor++;
    if (cursor >= order.length) break; // nothing left to give: this is the floor
    const p = order[cursor]!;
    const next = nextState(p)!;
    if (next.rung !== null) {
      const w = resolveWidth(p.item.inlineWidths, next.rung);
      if (w.kind !== "exact") p.spentEstimatedStep = true;
    }
    place(p, next.rung);
    iterations++;
  }

  // ── H1, the promote band ──────────────────────────────────────────────────
  // A demotion is accepted when `total > available`; a *promotion* — any item
  // ending wider than where it currently sits — only when the result clears the
  // width by `hysteresisPx`. The two predicates are disjoint, so no single width
  // both demands a demote and permits the matching promote, which is what stops
  // a row from flickering across a one-pixel resize.
  //
  // This is the ONLY place an unpinned item's `currentRung` is read. Refusing a
  // promotion can only leave items narrower than the computed ideal, so the
  // result still fits; the refusal is recorded nowhere and evaporates as soon as
  // the row is genuinely wider.
  const promoting = states.filter(
    (p) => !frozen.has(p.item.id) && isPromotion(p.item, p.rung),
  );
  if (promoting.length > 0 && !(total() + hysteresisPx <= available)) {
    for (const p of promoting) place(p, clampCurrent(p.item));
  }

  // Cohorts leave together: a member evicted above takes the rest of its
  // cohort with it. Evicting only ever frees width (the trigger is already
  // paid for, since a member is out), so the placement still fits — this pass
  // cannot undo what the search proved. A pinned member stays where it is: a
  // pin protects a live interaction from being moved.
  const leftCohorts = new Set<string>();
  for (const p of states) {
    if (p.rung === null && p.item.cohort != null)
      leftCohorts.add(p.item.cohort);
  }
  if (leftCohorts.size > 0) {
    for (const p of states) {
      if (
        p.rung !== null &&
        p.item.cohort != null &&
        leftCohorts.has(p.item.cohort) &&
        p.item.evictable &&
        !frozen.has(p.item.id)
      )
        place(p, null);
    }
  }

  const placement = new Map<string, number | null>();
  for (const p of states) placement.set(p.item.id, p.rung);

  return { placement, usedEstimate, fits: doesFit(), iterations };
}

/**
 * The item's current state, coerced to something it can legally occupy.
 *
 * A `currentRung` outside the ladder — the widget's rung count changed under us,
 * or the bar stopped offering the rung it was on because the widget renders
 * nothing there — or `null` on a non-evictable item is stale bookkeeping, not an
 * instruction to unmount a control. Clamp rather than trust it.
 *
 * The ladder is never empty (see `FitItem.inlineWidths`), so `last` is never
 * negative and this never invents a rung nobody can occupy.
 */
function clampCurrent(item: FitItem): number | null {
  if (item.currentRung === null) return item.evictable ? null : 0;
  const last = item.inlineWidths.length - 1;
  return Math.min(Math.max(item.currentRung, 0), last);
}

/** Is landing at `rung` wider than where the item currently is? */
function isPromotion(item: FitItem, rung: number | null): boolean {
  const current = clampCurrent(item);
  if (current === null) return rung !== null; // re-entering the row is the widest promotion there is
  if (rung === null) return false;
  return rung < current; // lower index = wider form
}
