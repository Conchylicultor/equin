import { describe, expect, it } from "bun:test";
import { Rank } from "@plugins/primitives/plugins/rank/core";
import {
  applyPendingMove,
  overlayRank,
  prunePendingMoves,
  prunePendingReseats,
  spellGroupValue,
  type PendingReseat,
  type PendingReseats,
  releasePendingMove,
  shouldClear,
  type CurrentRank,
  type PendingMove,
  type PendingMoves,
} from "./use-pending-move-overlay";

const a = Rank.between(null, null);
const b = Rank.between(a, null);
const c = Rank.between(b, null);

const EMPTY: PendingMoves = new Map();

describe("shouldClear", () => {
  const move: PendingMove = { rank: c, baseline: a };

  it("holds while the producer rank still equals the baseline", () => {
    expect(shouldClear(move, { present: true, rank: a })).toBe(false);
  });

  it("clears once the producer rank moved off the baseline", () => {
    expect(shouldClear(move, { present: true, rank: b })).toBe(true);
  });

  it("clears when the row disappeared", () => {
    expect(shouldClear(move, { present: false })).toBe(true);
  });

  it("compares a null baseline against null / a rank", () => {
    const unranked: PendingMove = { rank: c, baseline: null };
    expect(shouldClear(unranked, { present: true, rank: null })).toBe(false);
    expect(shouldClear(unranked, { present: true, rank: a })).toBe(true);
  });
});

describe("overlayRank", () => {
  it("returns the pending rank for a pending row, else the producer's", () => {
    const pending = applyPendingMove(EMPTY, "x", { rank: c, baseline: a });
    expect(overlayRank(pending, "x", a)).toBe(c);
    expect(overlayRank(pending, "y", b)).toBe(b);
  });
});

describe("applyPendingMove / releasePendingMove", () => {
  it("a re-drop of the same row replaces its entry", () => {
    const first: PendingMove = { rank: b, baseline: a };
    const second: PendingMove = { rank: c, baseline: a };
    const pending = applyPendingMove(
      applyPendingMove(EMPTY, "x", first),
      "x",
      second,
    );
    expect(pending.get("x")).toBe(second);
  });

  it("a rejected drop releases its own entry", () => {
    const move: PendingMove = { rank: b, baseline: a };
    const pending = applyPendingMove(EMPTY, "x", move);
    expect(releasePendingMove(pending, "x", move).has("x")).toBe(false);
  });

  it("an earlier drop's rejection leaves a later re-drop in place", () => {
    const first: PendingMove = { rank: b, baseline: a };
    const second: PendingMove = { rank: c, baseline: a };
    const pending = applyPendingMove(
      applyPendingMove(EMPTY, "x", first),
      "x",
      second,
    );
    expect(releasePendingMove(pending, "x", first)).toBe(pending);
  });
});

describe("prunePendingMoves", () => {
  const pending = applyPendingMove(
    applyPendingMove(EMPTY, "x", { rank: c, baseline: a }),
    "y",
    { rank: a, baseline: b },
  );

  it("returns the same map when nothing cleared", () => {
    const current = (id: string): CurrentRank =>
      id === "x" ? { present: true, rank: a } : { present: true, rank: b };
    expect(prunePendingMoves(pending, current)).toBe(pending);
  });

  it("drops the entries whose rank changed or whose row is gone", () => {
    const current = (id: string): CurrentRank =>
      id === "x" ? { present: true, rank: c } : { present: false };
    const next = prunePendingMoves(pending, current);
    expect(next.size).toBe(0);
    expect(pending.size).toBe(2); // input untouched
  });

  it("keeps the entries still waiting", () => {
    const current = (id: string): CurrentRank =>
      id === "x" ? { present: true, rank: a } : { present: false };
    expect([...prunePendingMoves(pending, current).keys()]).toEqual(["x"]);
  });
});

describe("prunePendingReseats", () => {
  const held: PendingReseat = {
    move: { id: "r", dest: { groupKey: "B" } },
    baseline: spellGroupValue("A"),
  };
  const pending: PendingReseats = new Map([["r", held]]);

  it("holds the row while its group-by value is still the drop-time one", () => {
    expect(
      prunePendingReseats(pending, () => ({ present: true, value: "A" })),
    ).toBe(pending);
  });

  it("lets go once the value moved, or the row left", () => {
    expect(
      prunePendingReseats(pending, () => ({ present: true, value: "B" })).size,
    ).toBe(0);
    expect(prunePendingReseats(pending, () => ({ present: false })).size).toBe(
      0,
    );
  });

  it("spells no value apart from any string", () => {
    expect(spellGroupValue(null)).toBe(spellGroupValue(undefined));
    expect(spellGroupValue(null)).not.toBe(spellGroupValue("null"));
    expect(spellGroupValue(1)).toBe("1");
  });
});
