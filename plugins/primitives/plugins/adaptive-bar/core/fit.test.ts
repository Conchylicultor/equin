/**
 * Tests for `assign` — the adaptive bar's rung/eviction decision.
 *
 * Every rule here exists because of a specific failure: a row that flickers
 * across a one-pixel resize (H1), a rung the bar keeps re-entering and being
 * thrown out of (H2), an item relocated to a panel that compaction alone would
 * have saved (the estimate rules), and a loop that never settles (termination).
 */

import { describe, expect, test } from "bun:test";
import { barRung, emptyBlockedRungs } from "./blocked-rungs";
import { assign, passBudget, type FitInput, type FitItem } from "./fit";

function item(over: Partial<FitItem> & { id: string }): FitItem {
  // `declaredRungs` defaults to the offered ladder's length — i.e. "nothing has
  // been cut" — so a test that cares about a cut states it, and every other test
  // reads as if the concept did not exist.
  return {
    inlineWidths: over.inlineWidths ?? [100],
    declaredRungs: (over.inlineWidths ?? [100]).length,
    evictable: true,
    yieldRank: 0,
    currentRung: 0,
    ...over,
  };
}

function fit(
  over: Partial<FitInput> & { items: readonly FitItem[] },
): FitInput {
  return {
    available: 1000,
    gap: 0,
    triggerPx: 0,
    hysteresisPx: 8,
    ...over,
  };
}

/** placement as a plain object, for readable assertions. */
function placed(input: FitInput): Record<string, number | null> {
  return Object.fromEntries(assign(input).placement);
}

describe("assign — the easy cases", () => {
  test("everything fits: nobody moves, nothing is estimated", () => {
    const r = assign(
      fit({
        available: 1000,
        gap: 10,
        items: [item({ id: "a" }), item({ id: "b" }), item({ id: "c" })],
      }),
    );
    expect(Object.fromEntries(r.placement)).toEqual({ a: 0, b: 0, c: 0 });
    expect(r.fits).toBe(true);
    expect(r.usedEstimate).toBe(false);
    expect(r.iterations).toBe(0);
  });

  test("an empty bar fits at any width", () => {
    const r = assign(fit({ available: 0, items: [] }));
    expect(r.placement.size).toBe(0);
    expect(r.fits).toBe(true);
  });

  test("the placement is total: every item handed in gets an entry", () => {
    // The driver decides what an occupant is — a contribution that renders
    // nothing at every form it was offered never arrives here — so a missing id
    // in the result means exactly one thing: this decision never saw it. When
    // that was two things, the web half read the hole as rung 0 and the bar
    // flipped a vanishing widget in and out of the row for ever.
    const items = [
      item({ id: "b", inlineWidths: [100, 50] }),
      item({ id: "c", inlineWidths: [100, 50] }),
    ];
    const roomy = assign(fit({ available: 210, gap: 10, items }));
    expect([...roomy.placement.keys()].sort()).toEqual(["b", "c"]);
    // And with no room at all, where every one of them is evicted.
    const tight = assign(fit({ available: 0, gap: 10, items }));
    expect([...tight.placement.keys()].sort()).toEqual(["b", "c"]);
  });

  test("one item over: exactly one demotion, on the eagerest yielder", () => {
    const ladder = [100, 50];
    const r = assign(
      fit({
        available: 270,
        gap: 10,
        items: [
          item({ id: "a", inlineWidths: ladder, yieldRank: 0 }),
          item({ id: "b", inlineWidths: ladder, yieldRank: 0 }),
          item({ id: "c", inlineWidths: ladder, yieldRank: 5 }),
        ],
      }),
    );
    // 100 + 100 + 50 + 2 gaps = 270 — exactly the width, so it fits.
    expect(Object.fromEntries(r.placement)).toEqual({ a: 0, b: 0, c: 1 });
    expect(r.iterations).toBe(1);
    expect(r.fits).toBe(true);
  });

  test("equal eagerness: the LATER item in bar order yields first", () => {
    const ladder = [100, 50];
    expect(
      placed(
        fit({
          available: 250,
          items: [
            item({ id: "a", inlineWidths: ladder, yieldRank: 1 }),
            item({ id: "b", inlineWidths: ladder, yieldRank: 1 }),
            item({ id: "c", inlineWidths: ladder, yieldRank: 0 }),
          ],
        }),
      ),
    ).toEqual({ a: 0, b: 1, c: 0 });
  });

  test("a non-evictable item at its last rung is simply kept, however tight", () => {
    const r = assign(
      fit({
        available: 0,
        items: [item({ id: "a", inlineWidths: [100, 40], evictable: false })],
      }),
    );
    expect(Object.fromEntries(r.placement)).toEqual({ a: 1 });
    expect(r.fits).toBe(false); // honest: the row overflows, the host must clip
  });
});

describe("assign — the trigger and the gaps", () => {
  test("the trigger is reserved exactly once, no matter how many items leave", () => {
    const items = [
      item({ id: "a", inlineWidths: [100], yieldRank: 0 }),
      item({ id: "b", inlineWidths: [100], yieldRank: 1 }),
      item({ id: "c", inlineWidths: [100], yieldRank: 2 }),
    ];
    // 1 inline (100) + 1 gap (10) + trigger (30) = 140.
    expect(
      placed(fit({ available: 150, gap: 10, triggerPx: 30, items })),
    ).toEqual({
      a: 0,
      b: null,
      c: null,
    });
    // 139 cannot hold that, and an empty row costs only the trigger: 30.
    expect(
      placed(fit({ available: 139, gap: 10, triggerPx: 30, items })),
    ).toEqual({
      a: null,
      b: null,
      c: null,
    });
  });
});

describe("assign — pinned items are frozen", () => {
  test("a pinned item keeps its rung while everything around it collapses", () => {
    const r = assign(
      fit({
        available: 0,
        items: [
          item({
            id: "dragging",
            inlineWidths: [100, 40],
            pinned: true,
            currentRung: 0,
          }),
          item({ id: "b", inlineWidths: [100, 40] }),
        ],
      }),
    );
    expect(Object.fromEntries(r.placement)).toEqual({ dragging: 0, b: null });
  });

  test("a pinned item that is currently evicted stays evicted", () => {
    const r = assign(
      fit({
        available: 1000,
        triggerPx: 30,
        items: [item({ id: "parked", pinned: true, currentRung: null })],
      }),
    );
    expect(Object.fromEntries(r.placement)).toEqual({ parked: null });
  });

  test("a pin cannot hold an occupant at a rung its ladder no longer reaches", () => {
    // The widget stopped rendering its compact form, so the bar cut the ladder
    // under an item that was sitting on it. A pin protects an interaction from
    // being MOVED; it must not freeze a widget into invisibility.
    const r = assign(
      fit({
        available: 10,
        items: [
          item({
            id: "pinned",
            pinned: true,
            currentRung: 1,
            inlineWidths: [100],
            declaredRungs: 2,
          }),
        ],
      }),
    );
    expect(Object.fromEntries(r.placement)).toEqual({ pinned: 0 });
  });

  test("a stale currentRung past the end of the ladder is clamped, not trusted", () => {
    const r = assign(
      fit({
        items: [
          item({
            id: "a",
            inlineWidths: [100, 40],
            pinned: true,
            currentRung: 7,
          }),
        ],
      }),
    );
    expect(Object.fromEntries(r.placement)).toEqual({ a: 1 });
  });
});

/**
 * MUTATION-VERIFIED. These assertions were confirmed to discriminate by
 * deliberately breaking the rule and watching them go red: replacing the band
 * predicate in `assign` (`!(total() + hysteresisPx <= available)`) with `false`
 * — i.e. never refusing a promotion — fails "refused at the band edge" and
 * "re-entering the row is a promotion too".
 *
 * So if one of these fails, the band is gone, not miscalibrated. Fix `assign`;
 * do not relax the number.
 */
describe("assign — H1, the promote band", () => {
  // One item, currently compact (rung 1). Widening it back to rung 0 costs 100.
  const promoting = (available: number): Record<string, number | null> =>
    placed(
      fit({
        available,
        hysteresisPx: 8,
        items: [
          item({
            id: "a",
            inlineWidths: [100, 60],
            evictable: false,
            currentRung: 1,
          }),
        ],
      }),
    );

  test("a promotion is refused at the band edge and accepted one pixel past", () => {
    expect(promoting(107)).toEqual({ a: 1 }); // 100 + 8 > 107 — still inside the band
    expect(promoting(108)).toEqual({ a: 0 }); // 100 + 8 ≤ 108 — cleared
  });

  test("the band is only a band: well past it, the item widens", () => {
    expect(promoting(500)).toEqual({ a: 0 });
  });

  test("demote and promote predicates are disjoint — a demotion needs no headroom", () => {
    // 99 < 100, so the widest form genuinely does not fit: demote, no band.
    expect(promoting(99)).toEqual({ a: 1 });
    // And at exactly 100 the widest form fits but has no headroom, so an item
    // ALREADY at rung 0 stays there — the same width never demands both.
    expect(
      placed(
        fit({
          available: 100,
          items: [
            item({
              id: "a",
              inlineWidths: [100, 60],
              evictable: false,
              currentRung: 0,
            }),
          ],
        }),
      ),
    ).toEqual({ a: 0 });
  });

  test("re-entering the row is a promotion too", () => {
    const items = [item({ id: "a", inlineWidths: [100], currentRung: null })];
    expect(placed(fit({ available: 100, triggerPx: 30, items }))).toEqual({
      a: null,
    });
    expect(placed(fit({ available: 108, triggerPx: 30, items }))).toEqual({
      a: 0,
    });
  });

  test("outside the band the answer ignores where the items currently are", () => {
    // Same input, three different current placements, ample headroom: one answer.
    const build = (currentRung: number | null): FitInput =>
      fit({
        available: 1000,
        gap: 10,
        items: [
          item({ id: "a", inlineWidths: [100, 60], currentRung }),
          item({ id: "b", inlineWidths: [100, 60], currentRung }),
        ],
      });
    const answers = [null, 0, 1].map((c) => placed(build(c)));
    expect(answers[0]).toEqual({ a: 0, b: 0 });
    expect(answers[1]).toEqual(answers[0]!);
    expect(answers[2]).toEqual(answers[0]!);
  });
});

describe("assign — H2, a rung that failed once is barred until the row grows", () => {
  const withBlock = (available: number): Record<string, number | null> =>
    placed(
      fit({
        available,
        hysteresisPx: 8,
        blocked: barRung(emptyBlockedRungs, "a", 0, 200),
        items: [
          item({
            id: "a",
            inlineWidths: [100, 60],
            evictable: false,
            currentRung: 1,
          }),
        ],
      }),
    );

  test("the barred rung is honoured even though it would fit", () => {
    expect(withBlock(208)).toEqual({ a: 1 }); // 208 is not > 200 + 8
  });

  test("the bar is released one pixel past atWidth + hysteresis", () => {
    expect(withBlock(209)).toEqual({ a: 0 });
  });

  test("a barred rung is skipped over, not stopped at, on the way down", () => {
    const r = assign(
      fit({
        available: 30,
        blocked: barRung(emptyBlockedRungs, "a", 1, 10_000),
        items: [
          item({
            id: "a",
            inlineWidths: [100, 60, 20],
            evictable: false,
            currentRung: 0,
          }),
        ],
      }),
    );
    expect(Object.fromEntries(r.placement)).toEqual({ a: 2 });
  });

  test("barring a narrow rung bars the wider ones too, at any width", () => {
    // The monotone implication, at the level that consumes it. Rung 0 is wider
    // than rung 1, so a rung-1 rejection is a rung-0 rejection — and an exact
    // `rung === r` match would seat the item at rung 0, promoting it straight
    // past the form the row just learned does not fit.
    const r = assign(
      fit({
        available: 1000,
        blocked: barRung(emptyBlockedRungs, "a", 1, 10_000),
        items: [
          item({
            id: "a",
            inlineWidths: [100, 60, 20],
            evictable: false,
            currentRung: 2,
          }),
        ],
      }),
    );
    expect(Object.fromEntries(r.placement)).toEqual({ a: 2 });
  });

  test("a barred sole rung never unmounts a mandatory control", () => {
    const r = assign(
      fit({
        available: 1000,
        blocked: barRung(emptyBlockedRungs, "a", 0, 10_000),
        items: [item({ id: "a", inlineWidths: [100], evictable: false })],
      }),
    );
    expect(Object.fromEntries(r.placement)).toEqual({ a: 0 });
  });
});

/**
 * MUTATION-VERIFIED, same method: deleting the one line in `assign` that marks
 * an item as having taken an estimated step (`p.spentEstimatedStep = true`)
 * fails three of these — the item is evicted outright instead of stopping one
 * rung down, which is the exact bug the rule exists to prevent (a widget
 * relocated on a guess is never measured again, so the guess is unlearnable).
 *
 * A failure here means the cap is missing, not that the expectations are
 * strict.
 */
describe("assign — estimates may block a fit, never fabricate one", () => {
  test("an unmeasured rung is bounded by the wider rung, so it can refuse a fit", () => {
    const build = (compact: number | undefined): FitInput =>
      fit({
        available: 240,
        items: [
          item({ id: "a", inlineWidths: [100, compact], yieldRank: 1 }),
          item({
            id: "b",
            inlineWidths: [200],
            evictable: false,
            yieldRank: 0,
          }),
        ],
      });

    // Measured: 200 + 40 = 240 fits exactly.
    const exact = assign(build(40));
    expect(Object.fromEntries(exact.placement)).toEqual({ a: 1, b: 0 });
    expect(exact.fits).toBe(true);
    expect(exact.usedEstimate).toBe(false);

    // Unmeasured: the only sound bound for the compact rung is the full width,
    // so the row is reported as NOT fitting — pessimistic, never optimistic.
    const guessed = assign(build(undefined));
    expect(Object.fromEntries(guessed.placement)).toEqual({ a: 1, b: 0 });
    expect(guessed.fits).toBe(false);
    expect(guessed.usedEstimate).toBe(true);
  });

  test("a width with no bound at all never counts as fitting", () => {
    const r = assign(
      fit({
        available: 10_000,
        items: [item({ id: "a", inlineWidths: [undefined], evictable: false })],
      }),
    );
    expect(Object.fromEntries(r.placement)).toEqual({ a: 0 });
    expect(r.fits).toBe(false);
    expect(r.usedEstimate).toBe(true);
  });

  test("never skip a rung while estimating: at most one step per pass", () => {
    // Rungs 1 and 2 have never been measured. Even at zero available width the
    // item may only take ONE step — otherwise it would relocate to the panel on
    // a guess, and a panelled item is never measured again.
    const guessing = assign(
      fit({
        available: 0,
        items: [item({ id: "a", inlineWidths: [100, undefined, undefined] })],
      }),
    );
    expect(Object.fromEntries(guessing.placement)).toEqual({ a: 1 });
    expect(guessing.iterations).toBe(1);
    expect(guessing.usedEstimate).toBe(true);

    // With every rung measured there is nothing to learn, so the same width
    // takes the item all the way out.
    const known = assign(
      fit({
        available: 0,
        items: [item({ id: "a", inlineWidths: [100, 40, 20] })],
      }),
    );
    expect(Object.fromEntries(known.placement)).toEqual({ a: null });
    expect(known.iterations).toBe(3);
    expect(known.usedEstimate).toBe(false);
  });

  test("an estimated step does not stop the OTHER items from yielding", () => {
    const r = assign(
      fit({
        available: 0,
        items: [
          item({ id: "guess", inlineWidths: [100, undefined], yieldRank: 9 }),
          item({ id: "known", inlineWidths: [100, 40], yieldRank: 0 }),
        ],
      }),
    );
    expect(Object.fromEntries(r.placement)).toEqual({ guess: 1, known: null });
  });
});

describe("assign — termination", () => {
  /** Σ stepsRemaining at the start: the potential that must strictly decrease. */
  function potential(items: readonly FitItem[]): number {
    return items.reduce(
      (acc, i) => acc + (i.inlineWidths.length - 1) + (i.evictable ? 1 : 0),
      0,
    );
  }

  /** Is every item at its narrowest legal state? */
  function isFloor(
    items: readonly FitItem[],
    placement: ReadonlyMap<string, number | null>,
  ): boolean {
    return items.every((i) => {
      const at = placement.get(i.id);
      return i.evictable ? at === null : at === i.inlineWidths.length - 1;
    });
  }

  test("property: random ladders settle in ≤ Σ steps and land on a fit or the floor", () => {
    let seed = 0xc0ffee;
    const rand = (n: number): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };

    for (let trial = 0; trial < 500; trial++) {
      const n = 1 + rand(8);
      const items: FitItem[] = Array.from({ length: n }, (_, k) => {
        const rungs = 1 + rand(3);
        // Monotone, as the contract promises: a narrower form is never wider.
        let px = 20 + rand(180);
        const inlineWidths: number[] = [px];
        for (let r = 1; r < rungs; r++) {
          px = Math.max(1, px - rand(px));
          inlineWidths.push(px);
        }
        return {
          id: `i${k}`,
          inlineWidths,
          declaredRungs: rungs,
          evictable: rand(2) === 0,
          yieldRank: rand(4),
          currentRung: 0,
        };
      });
      const input = fit({
        items,
        available: rand(900),
        gap: rand(12),
        triggerPx: rand(40),
      });

      const r = assign(input);
      expect(r.iterations).toBeLessThanOrEqual(potential(items));
      expect(r.usedEstimate).toBe(false);
      expect(r.fits || isFloor(items, r.placement)).toBe(true);
    }
  });

  test("a three-rung non-evictable bar settles within 2n demotions", () => {
    const items = Array.from({ length: 20 }, (_, k) =>
      item({
        id: `i${k}`,
        inlineWidths: [100, 60, 30],
        evictable: false,
        yieldRank: k % 3,
      }),
    );
    const r = assign(fit({ items, available: 0 }));
    expect(r.iterations).toBeLessThanOrEqual(2 * items.length);
  });

  test("the search is not quadratic: a very wide bar collapses promptly", () => {
    // A rescan-for-the-best-candidate loop is O(n²) and would take minutes here;
    // the sorted single-cursor walk is O(n log n).
    const n = 50_000;
    const items = Array.from({ length: n }, (_, k) =>
      item({ id: `i${k}`, inlineWidths: [100, 60, 30], yieldRank: k % 7 }),
    );
    const started = performance.now();
    const r = assign(fit({ items, available: 0, gap: 4, triggerPx: 32 }));
    expect(performance.now() - started).toBeLessThan(3000);
    expect(r.iterations).toBe(3 * n);
  });
});

describe("an item whose width is unknown at every rung", () => {
  /**
   * The absorbing state, as a test.
   *
   * `staleOthers` downgrades an item's OTHER rungs the moment its current one
   * measures differently — so an occupant sitting at its compact rung whose
   * content changes leaves rung 0 with no exact width and nothing wider to bound
   * it. Before the demotability rule below, the very next fit seeded it there,
   * `doesFit` was false forever, every evictable occupant went to the panel, the
   * placement was stable — so the bar CONVERGED on the floor, filed nothing, and
   * could never recover: only an inline node is measurable, so the width it was
   * missing could never be learned.
   */
  test("stays in the row rather than being evicted into permanent ignorance", () => {
    const r = assign(
      fit({
        available: 100,
        items: [
          item({ id: "known", inlineWidths: [80] }),
          item({
            id: "unknown",
            inlineWidths: [undefined, 40],
            currentRung: 1,
          }),
        ],
      }),
    );
    // It cannot be sized, so it cannot be blamed for the overflow and must not
    // be moved somewhere it can never be measured again.
    expect(r.placement.get("unknown")).toBe(0);
    // Everything sizeable still gives what it can, and the row is honest about
    // not fitting.
    expect(r.placement.get("known")).toBe(null);
    expect(r.fits).toBe(false);
  });

  test("an unmeasurable item does not stop the others from compacting", () => {
    const r = assign(
      fit({
        available: 100,
        items: [
          item({ id: "a", inlineWidths: [80, 30], evictable: false }),
          item({ id: "unknown", inlineWidths: [undefined], currentRung: 0 }),
        ],
      }),
    );
    expect(r.placement.get("a")).toBe(1);
    expect(r.placement.get("unknown")).toBe(0);
  });
});

describe("passBudget — how many rounds a search may legitimately take", () => {
  test("never below the constant it replaced", () => {
    expect(passBudget([])).toBe(4);
    expect(passBudget([item({ id: "a", inlineWidths: [100] })])).toBe(4);
  });

  test("grows with the steps the row actually has to give", () => {
    // Six two-rung evictable occupants: each can compact once and leave once, so
    // the search may need to walk twelve steps — and a fixed budget of four
    // reported that as a search that does not terminate.
    const items = Array.from({ length: 6 }, (_, k) =>
      item({ id: `i${k}`, inlineWidths: [100, 60] }),
    );
    expect(passBudget(items)).toBe(14);
  });

  test("counts the rungs the widget DECLARED, not the ones still offered", () => {
    // A rung the bar has stopped offering is not a step the row lost — it is a
    // step the search spent a round discovering. Charging the budget for it
    // would take the round away twice.
    const cut = [
      item({ id: "a", inlineWidths: [100], declaredRungs: 2 }),
      item({ id: "b", inlineWidths: [100], declaredRungs: 2 }),
      item({ id: "c", inlineWidths: [100], declaredRungs: 2 }),
    ];
    const whole = [
      item({ id: "a", inlineWidths: [100, 60] }),
      item({ id: "b", inlineWidths: [100, 60] }),
      item({ id: "c", inlineWidths: [100, 60] }),
    ];
    expect(passBudget(cut)).toBe(passBudget(whole));
    expect(passBudget(cut)).toBe(8);
  });

  test("clamped well below React's own nested-update limit", () => {
    const items = Array.from({ length: 200 }, (_, k) =>
      item({ id: `i${k}`, inlineWidths: [100, 60, 30] }),
    );
    expect(passBudget(items)).toBe(16);
  });
});

describe("assign — cohorts leave together", () => {
  test("one member evicted takes every evictable member of its cohort", () => {
    // Room for wish + one page: the fit alone would keep page "a" inline.
    const r = placed(
      fit({
        available: 250,
        items: [
          item({ id: "a", cohort: "pages" }),
          item({ id: "b", cohort: "pages" }),
          item({ id: "c", cohort: "pages" }),
          item({ id: "wish", yieldRank: -1 }),
        ],
      }),
    );
    expect(r).toEqual({ a: null, b: null, c: null, wish: 0 });
  });

  test("a cohort that fits stays inline", () => {
    const r = placed(
      fit({
        available: 1000,
        items: [
          item({ id: "a", cohort: "pages" }),
          item({ id: "b", cohort: "pages" }),
        ],
      }),
    );
    expect(r).toEqual({ a: 0, b: 0 });
  });

  test("items outside the cohort, and pinned members, stay where the fit put them", () => {
    const r = placed(
      fit({
        available: 200,
        items: [
          item({ id: "a", cohort: "pages", pinned: true }),
          item({ id: "b", cohort: "pages" }),
          item({ id: "c", cohort: "pages" }),
          item({ id: "other" }),
        ],
      }),
    );
    // The fit evicts from the end (ties go to the later item): "other" and "c"
    // leave, so "b" follows its cohort; pinned "a" stays put.
    expect(r).toEqual({ a: 0, b: null, c: null, other: null });
  });
});
