/**
 * Pure unit suite for the order-ops. No React, no DB.
 *
 * Run: `bun test plugins/primitives/plugins/data-view/plugins/view-order/core`
 */

import { describe, test, expect } from "bun:test";
import { Rank } from "@plugins/primitives/plugins/rank/core";
import {
  seedRanks,
  applyMove,
  computeMoveWrites,
  computeInsertWrites,
  type RowOrderWrite,
} from "./order-ops";

/** The displayed sequence: keys sorted by their (total) synthesized rank. */
function displayOrder(ranks: ReadonlyMap<string, Rank>): string[] {
  return [...ranks.entries()]
    .sort(([, a], [, b]) => Rank.compare(a, b))
    .map(([key]) => key);
}

/** A dense persisted order, exactly what the server used to write for `order`. */
function persist(order: readonly string[]): Map<string, Rank> {
  const ranks = Rank.nBetween(null, null, order.length);
  return new Map(order.map((key, i): [string, Rank] => [key, ranks[i]!]));
}

/**
 * Fold a bounded write set into a persisted map (the server's upsert: nothing is
 * deleted, present keys are overwritten). Returns a NEW map.
 */
function applyWrites(
  persisted: ReadonlyMap<string, Rank>,
  writes: readonly RowOrderWrite[],
): Map<string, Rank> {
  const next = new Map(persisted);
  for (const w of writes) next.set(w.rowKey, w.rank);
  return next;
}

/** The display order the client sees for `orderedKeys` under a persisted map. */
function displayOf(
  orderedKeys: readonly string[],
  persisted: ReadonlyMap<string, Rank>,
): string[] {
  return displayOrder(seedRanks(orderedKeys, persisted));
}

/**
 * The invariant `computeMoveWrites` preserves: under `seedRanks`, every persisted
 * key sorts strictly before every seeded (unpersisted) key.
 */
function persistedBeforeSeeded(
  orderedKeys: readonly string[],
  persisted: ReadonlyMap<string, Rank>,
): boolean {
  const display = displayOf(orderedKeys, persisted);
  let sawSeed = false;
  for (const key of display) {
    if (persisted.has(key)) {
      if (sawSeed) return false; // a persisted key after a seed → violated
    } else {
      sawSeed = true;
    }
  }
  return true;
}

describe("seedRanks", () => {
  test("seeds an all-unpersisted list in source order", () => {
    const ranks = seedRanks(["A", "B", "C"], new Map());
    expect(ranks.size).toBe(3);
    expect(Rank.compare(ranks.get("A")!, ranks.get("B")!)).toBe(-1);
    expect(Rank.compare(ranks.get("B")!, ranks.get("C")!)).toBe(-1);
  });

  test("is total — every ordered key gets a rank", () => {
    const ranks = seedRanks(["A", "B"], persist(["A"]));
    expect([...ranks.keys()].sort()).toEqual(["A", "B"]);
  });

  test("appends unpersisted keys after max(persisted), in source order", () => {
    // "B" is persisted first but sorts LAST among the persisted ranks, so the
    // seeds must land after it — not after the first-seen persisted rank.
    const persisted = persist(["C", "B"]);
    expect(displayOrder(seedRanks(["A", "B", "C", "D"], persisted))).toEqual([
      "C",
      "B",
      "A",
      "D",
    ]);
  });

  test("max(persisted) spans keys absent from the ordered set", () => {
    // "Z" is filtered out of the view (not in orderedKeys) but still holds the
    // highest rank. "A" seeds after Z, so it displays after "B" despite coming
    // first in source order.
    const persisted = persist(["B", "Z"]);
    expect(displayOrder(seedRanks(["A", "B"], persisted))).toEqual(["B", "A"]);
  });
});

describe("applyMove", () => {
  test("re-inserts before the target", () => {
    expect(applyMove(["A", "B", "C"], "C", "B", "before")).toEqual([
      "A",
      "C",
      "B",
    ]);
  });

  test("re-inserts after the target", () => {
    expect(applyMove(["A", "B", "C"], "A", "B", "after")).toEqual([
      "B",
      "A",
      "C",
    ]);
  });

  test("zone 'after' at the tail appends", () => {
    expect(applyMove(["A", "B", "C"], "A", "C", "after")).toEqual([
      "B",
      "C",
      "A",
    ]);
  });

  test("moving a row to its own current neighbour position is a no-op sequence", () => {
    // A already sits immediately before B — dropping it there changes nothing.
    expect(applyMove(["A", "B", "C"], "A", "B", "before")).toEqual([
      "A",
      "B",
      "C",
    ]);
  });

  test("dropping a row onto itself returns the unchanged sequence", () => {
    expect(applyMove(["A", "B", "C"], "B", "B", "before")).toEqual([
      "A",
      "B",
      "C",
    ]);
  });

  test("returns null for an unknown targetId", () => {
    expect(applyMove(["A", "B", "C"], "A", "Z", "before")).toBeNull();
  });

  test("returns null for an unknown dragged id", () => {
    expect(applyMove(["A", "B", "C"], "Z", "A", "before")).toBeNull();
  });
});

describe("computeMoveWrites", () => {
  /** Run the drag and fold the result back — the display the next render shows. */
  function moveAndDisplay(
    orderedKeys: readonly string[],
    persisted: ReadonlyMap<string, Rank>,
    id: string,
    targetId: string,
    zone: "before" | "after",
  ): { writes: RowOrderWrite[] | null; display: string[] } {
    const writes = computeMoveWrites({ orderedKeys, persisted, id, targetId, zone });
    if (writes === null) return { writes: null, display: [] };
    const folded = applyWrites(persisted, writes);
    return { writes, display: displayOf(orderedKeys, folded) };
  }

  test("all-unpersisted drag lands where dropped (A,B,C → C before B → A,C,B)", () => {
    const { display } = moveAndDisplay(["A", "B", "C"], new Map(), "C", "B", "before");
    expect(display).toEqual(["A", "C", "B"]);
  });

  test("downward seed drag materializes by next-position, not a source prefix", () => {
    // Seeds A..E, nothing persisted. Drag B before D → display A,C,B,D,E, and the
    // write set covers exactly A,C,B (the seeds now ahead of B, in next-order).
    //
    // A "first m seeds in SOURCE order" rule would emit only {A,B} (m=2 skipping
    // B → A, then B) and silently no-op the drag: C would still seed before B.
    const seeds = ["A", "B", "C", "D", "E"];
    const { writes, display } = moveAndDisplay(seeds, new Map(), "B", "D", "before");
    expect(display).toEqual(["A", "C", "B", "D", "E"]);
    expect(writes!.map((w) => w.rowKey)).toEqual(["A", "C", "B"]);
  });

  test("second-drag regression: the move is over DISPLAY order, not source", () => {
    // The first drag persisted [A,C,B]; the source order is still [A,B,C]. Drag A
    // after B. The correct result is over the DISPLAY order (A,C,B): removing A
    // and re-inserting it after B gives C,B,A.
    const persisted = persist(["A", "C", "B"]);
    const { display } = moveAndDisplay(["A", "B", "C"], persisted, "A", "B", "after");
    expect(display).toEqual(["C", "B", "A"]);
    // The OLD bug computed applyMove(SOURCE=[A,B,C], A after B) = [B,A,C]. Pin
    // that we do NOT reproduce it (the source-vs-display bug).
    expect(display).not.toEqual(["B", "A", "C"]);
  });

  describe("cost gates — a drag costs O(gesture), not O(view)", () => {
    const keys = Array.from({ length: 1000 }, (_, i) => `k${i.toString().padStart(4, "0")}`);
    const never = new Map<string, Rank>(); // never arranged

    test("drag row 1 above row 0 → 1 write", () => {
      const writes = computeMoveWrites({
        orderedKeys: keys,
        persisted: never,
        id: keys[1]!,
        targetId: keys[0]!,
        zone: "before",
      });
      expect(writes).not.toBeNull();
      expect(writes!.length).toBe(1);
    });

    test("drag row 900 to the top → 1 write", () => {
      const writes = computeMoveWrites({
        orderedKeys: keys,
        persisted: never,
        id: keys[900]!,
        targetId: keys[0]!,
        zone: "before",
      });
      expect(writes!.length).toBe(1);
    });

    test("drag row 0 to just before row 900 → 900 writes (the O(view) tail case)", () => {
      // Dropping deep into a never-arranged tail declares an order for everything
      // above the drop: rows 1..899 (899 seeds) become ahead of row 0, plus row 0
      // itself = 900 writes.
      const writes = computeMoveWrites({
        orderedKeys: keys,
        persisted: never,
        id: keys[0]!,
        targetId: keys[900]!,
        zone: "before",
      });
      expect(writes!.length).toBe(900);
    });
  });

  test("a row entering the view after an arrangement still seeds to the tail", () => {
    // "D" is new (no persisted entry) and appears mid-source-order; it must seed
    // last, after the arranged prefix — unchanged by the bounded rule.
    const persisted = persist(["A", "C", "B"]);
    expect(displayOf(["A", "D", "B", "C"], persisted)).toEqual(["A", "C", "B", "D"]);
  });

  test("null for an unknown id", () => {
    expect(
      computeMoveWrites({
        orderedKeys: ["A", "B", "C"],
        persisted: new Map(),
        id: "Z",
        targetId: "A",
        zone: "before",
      }),
    ).toBeNull();
  });

  test("null for an unknown targetId", () => {
    expect(
      computeMoveWrites({
        orderedKeys: ["A", "B", "C"],
        persisted: new Map(),
        id: "A",
        targetId: "Z",
        zone: "before",
      }),
    ).toBeNull();
  });

  test("[] for dropping a row onto itself", () => {
    expect(
      computeMoveWrites({
        orderedKeys: ["A", "B", "C"],
        persisted: new Map(),
        id: "B",
        targetId: "B",
        zone: "before",
      }),
    ).toEqual([]);
  });

  test("[] for an already-adjacent drop", () => {
    // A already sits immediately before B — dropping it there changes nothing.
    expect(
      computeMoveWrites({
        orderedKeys: ["A", "B", "C"],
        persisted: new Map(),
        id: "A",
        targetId: "B",
        zone: "before",
      }),
    ).toEqual([]);
  });
});

describe("computeMoveWrites round-trip stability (the real gate)", () => {
  /**
   * A deterministic LCG (NO Math.random) so a failing seed is reproducible.
   * Numerical Recipes constants.
   */
  function lcg(seed: number): () => number {
    let s = seed >>> 0;
    return () => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return s / 0x100000000;
    };
  }

  test("folding writes reproduces exactly what applyMove(display, …) produced", () => {
    const rand = lcg(0xc0ffee);
    const pick = <T>(arr: readonly T[]): T => arr[Math.floor(rand() * arr.length)]!;

    let draws = 0;
    for (let iter = 0; iter < 2000 && draws < 500; iter++) {
      // A random ordered set of 2..9 keys.
      const n = 2 + Math.floor(rand() * 8);
      const orderedKeys = Array.from({ length: n }, (_, i) => `r${i}`);

      // A random subset persisted, with dense ranks in a RANDOM display order
      // (so source order and display order genuinely diverge).
      const shuffled = [...orderedKeys];
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
      }
      const persistCount = Math.floor(rand() * (n + 1)); // 0..n
      const persisted = persist(shuffled.slice(0, persistCount));

      const id = pick(orderedKeys);
      const targetId = pick(orderedKeys);
      const zone: "before" | "after" = rand() < 0.5 ? "before" : "after";

      // The reference `next`: applyMove over the DISPLAY order.
      const display = displayOf(orderedKeys, persisted);
      const next = applyMove(display, id, targetId, zone);
      if (next === null) continue; // id === targetId can't happen (both members)

      const writes = computeMoveWrites({ orderedKeys, persisted, id, targetId, zone });
      expect(writes).not.toBeNull();
      draws++;

      const folded = applyWrites(persisted, writes!);
      // The next render's display must reproduce `next` EXACTLY.
      expect(displayOf(orderedKeys, folded)).toEqual(next);
      // And the standing invariant still holds after the fold.
      expect(persistedBeforeSeeded(orderedKeys, folded)).toBe(true);
    }

    // Guard the loop actually exercised the intended number of moves.
    expect(draws).toBeGreaterThanOrEqual(500);
  });
});

describe("computeInsertWrites", () => {
  test("a row not created yet lands in the gap it was dropped in", () => {
    // Home, Downloads, Singularity built in, one pin; nothing arranged yet. A
    // new pin dropped after Home: Home is materialized as its anchor.
    const orderedKeys = ["home", "dl", "sing", "pin:a"];
    const writes = computeInsertWrites({
      orderedKeys,
      persisted: new Map(),
      keys: ["pin:new"],
      targetId: "home",
      zone: "after",
    });
    expect(writes!.map((w) => w.rowKey)).toEqual(["home", "pin:new"]);
    // The row appears (at the END of its source order) once the consumer
    // writes it, and renders where it was dropped.
    const folded = applyWrites(new Map(), writes!);
    expect(displayOf([...orderedKeys, "pin:new"], folded)).toEqual([
      "home",
      "pin:new",
      "dl",
      "sing",
      "pin:a",
    ]);
  });

  test("several keys land as one run, in the given order", () => {
    const orderedKeys = ["A", "B", "C"];
    const persisted = persist(["A", "B", "C"]);
    const writes = computeInsertWrites({
      orderedKeys,
      persisted,
      keys: ["Y", "C", "X"],
      targetId: "B",
      zone: "before",
    });
    expect(writes!.map((w) => w.rowKey)).toEqual(["Y", "C", "X"]);
    const folded = applyWrites(persisted, writes!);
    expect(displayOf(["X", ...orderedKeys, "Y"], folded)).toEqual([
      "A",
      "Y",
      "C",
      "X",
      "B",
    ]);
  });

  test("a present key moves exactly as computeMoveWrites moves it", () => {
    const args = {
      orderedKeys: ["A", "B", "C", "D"],
      persisted: persist(["B", "A"]),
      targetId: "A",
      zone: "after" as const,
    };
    expect(computeInsertWrites({ ...args, keys: ["D"] })).toEqual(
      computeMoveWrites({ ...args, id: "D" }),
    );
  });

  test("null for a target outside the ordered set", () => {
    expect(
      computeInsertWrites({
        orderedKeys: ["A"],
        persisted: new Map(),
        keys: ["N"],
        targetId: "Z",
        zone: "after",
      }),
    ).toBeNull();
  });

  test("[] for a drop on the target's own edge, an adjacent drop, or no keys", () => {
    const base = {
      orderedKeys: ["A", "B"],
      persisted: new Map<string, Rank>(),
    };
    expect(
      computeInsertWrites({
        ...base,
        keys: ["A"],
        targetId: "A",
        zone: "after",
      }),
    ).toEqual([]);
    expect(
      computeInsertWrites({
        ...base,
        keys: ["A"],
        targetId: "B",
        zone: "before",
      }),
    ).toEqual([]);
    expect(
      computeInsertWrites({ ...base, keys: [], targetId: "B", zone: "after" }),
    ).toEqual([]);
  });

  test("an absent key dropped after the last seed persists the whole prefix", () => {
    // The drop is past every row: each seed ahead of it is materialized.
    const writes = computeInsertWrites({
      orderedKeys: ["A", "B"],
      persisted: new Map(),
      keys: ["N"],
      targetId: "B",
      zone: "after",
    });
    expect(writes!.map((w) => w.rowKey)).toEqual(["A", "B", "N"]);
  });

  test("round trip: folding writes reproduces the drop, new rows anywhere in source order", () => {
    let s = 0x5eed >>> 0;
    const rand = () => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return s / 0x100000000;
    };
    const pick = <T>(arr: readonly T[]): T =>
      arr[Math.floor(rand() * arr.length)]!;
    const shuffle = <T>(arr: readonly T[]): T[] => {
      const out = [...arr];
      for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [out[i], out[j]] = [out[j]!, out[i]!];
      }
      return out;
    };

    let draws = 0;
    for (let iter = 0; iter < 800; iter++) {
      const n = 1 + Math.floor(rand() * 7);
      const orderedKeys = Array.from({ length: n }, (_, i) => `r${i}`);
      const persisted = persist(
        shuffle(orderedKeys).slice(0, Math.floor(rand() * (n + 1))),
      );
      const fresh = Array.from(
        { length: Math.floor(rand() * 3) },
        (_, i) => `new${i}`,
      );
      const moved = orderedKeys.filter(() => rand() < 0.3);
      const keys = shuffle([...fresh, ...moved]);
      if (keys.length === 0) continue;
      const targetId = pick(orderedKeys);
      const zone: "before" | "after" = rand() < 0.5 ? "before" : "after";

      const writes = computeInsertWrites({
        orderedKeys,
        persisted,
        keys,
        targetId,
        zone,
      });
      expect(writes).not.toBeNull();
      for (let i = 1; i < writes!.length; i++) {
        expect(Rank.compare(writes![i - 1]!.rank, writes![i]!.rank)).toBe(-1);
      }

      // The expected display: the run spliced next to the target.
      const before = displayOf(orderedKeys, persisted);
      const moving = keys.filter((k) => k !== targetId);
      const run = keys.includes(targetId)
        ? zone === "before"
          ? [...moving, targetId]
          : [targetId, ...moving]
        : moving;
      const rest = before.filter((k) => !moving.includes(k));
      const at = rest.indexOf(targetId);
      const expected = keys.includes(targetId)
        ? [...rest.slice(0, at), ...run, ...rest.slice(at + 1)]
        : zone === "before"
          ? [...rest.slice(0, at), ...run, ...rest.slice(at)]
          : [...rest.slice(0, at + 1), ...run, ...rest.slice(at + 1)];

      // The new rows appear at random places in the source order.
      const after = [...orderedKeys];
      for (const k of fresh) {
        after.splice(Math.floor(rand() * (after.length + 1)), 0, k);
      }
      const folded = applyWrites(persisted, writes!);
      expect(displayOf(after, folded)).toEqual(expected);
      expect(persistedBeforeSeeded(after, folded)).toBe(true);
      draws++;
    }
    expect(draws).toBeGreaterThanOrEqual(400);
  });
});
