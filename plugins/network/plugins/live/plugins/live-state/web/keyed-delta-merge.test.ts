/**
 * Tests for the keyed-delta merge core. Run with
 * `bun test plugins/network/plugins/live/plugins/live-state/`.
 *
 * The load-bearing invariant under test: a merged array is NEVER returned with
 * a hole (`undefined`). When `order` names an id the client cannot resolve
 * (base drift from a missed/stale-dropped frame), the merge must report
 * `{ kind: "drift" }` so the caller resubs for a fresh base — it must not guess
 * `undefined` and write it into the array, which is the bug that crashed the
 * dependencies button (`allTasks.filter((t) => t.dependencies...)` on a hole).
 *
 * Three layers: explicit scenarios (incl. the exact production case), a
 * property test over random single deltas, and a lossy-channel simulation that
 * fuzzes correlated delta sequences with dropped frames and resub-on-drift.
 */

import { test, expect, describe } from "bun:test";
import { mergeKeyedDelta, type KeyedDeltaResult } from "./keyed-delta-merge";

type Row = { id: string; v: number };
const keyOf = (r: unknown) => (r as Row).id;
const mapOf = (rows: Row[]) => new Map<string, unknown>(rows.map((r) => [r.id, r]));

// Deterministic PRNG (mulberry32) so a fuzz failure is reproducible from its
// seed — `Math.random()` would make a red run impossible to replay.
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Asserts the result is a clean merge whose rows are hole-free and well-formed.
function expectHoleFree(result: KeyedDeltaResult): readonly unknown[] {
  expect(result.kind).toBe("merged");
  if (result.kind !== "merged") throw new Error("unreachable");
  for (const row of result.rows) {
    expect(row).toBeDefined();
    expect(row).not.toBeNull();
    expect(typeof (row as Row).id).toBe("string");
  }
  return result.rows;
}

describe("mergeKeyedDelta — scenarios", () => {
  test("EXACT production bug: order names an id in neither upserts nor base ⇒ drift, not a hole", () => {
    // The repro: a new task id ('C') landed in `order` while its row never
    // reached this client. Old code produced [A, B, undefined]; consumers then
    // crashed on `undefined.dependencies`.
    const base: Row[] = [{ id: "A", v: 1 }, { id: "B", v: 1 }];
    const result = mergeKeyedDelta(base, new Map(), ["A", "B", "C"], keyOf);
    expect(result).toEqual({ kind: "drift", missingIds: ["C"] });
  });

  test("in-place upserts (order undefined): swap by id, length preserved, no holes", () => {
    const base: Row[] = [{ id: "A", v: 1 }, { id: "B", v: 1 }];
    const result = mergeKeyedDelta(base, mapOf([{ id: "B", v: 2 }]), undefined, keyOf);
    const rows = expectHoleFree(result);
    expect(rows).toEqual([{ id: "A", v: 1 }, { id: "B", v: 2 }]);
  });

  test("in-place upsert for an id absent from base is ignored (membership unchanged)", () => {
    const base: Row[] = [{ id: "A", v: 1 }];
    const result = mergeKeyedDelta(base, mapOf([{ id: "Z", v: 9 }]), undefined, keyOf);
    expect(expectHoleFree(result)).toEqual([{ id: "A", v: 1 }]);
  });

  test("membership add: new id present in upserts is placed by order", () => {
    const base: Row[] = [{ id: "A", v: 1 }];
    const result = mergeKeyedDelta(base, mapOf([{ id: "B", v: 1 }]), ["A", "B"], keyOf);
    expect(expectHoleFree(result)).toEqual([{ id: "A", v: 1 }, { id: "B", v: 1 }]);
  });

  test("membership delete: id dropped from order is excluded", () => {
    const base: Row[] = [{ id: "A", v: 1 }, { id: "B", v: 1 }];
    const result = mergeKeyedDelta(base, new Map(), ["A"], keyOf);
    expect(expectHoleFree(result)).toEqual([{ id: "A", v: 1 }]);
  });

  test("reorder with no content change: order applied, every id from base", () => {
    const base: Row[] = [{ id: "A", v: 1 }, { id: "B", v: 1 }, { id: "C", v: 1 }];
    const result = mergeKeyedDelta(base, new Map(), ["C", "A", "B"], keyOf);
    expect(expectHoleFree(result)).toEqual([{ id: "C", v: 1 }, { id: "A", v: 1 }, { id: "B", v: 1 }]);
  });

  test("unchanged rows keep their object reference (memoized-row no-churn guarantee)", () => {
    const a = { id: "A", v: 1 };
    const b = { id: "B", v: 1 };
    const result = mergeKeyedDelta([a, b], mapOf([{ id: "B", v: 2 }]), ["A", "B"], keyOf);
    if (result.kind !== "merged") throw new Error("unreachable");
    expect(result.rows[0]).toBe(a); // same reference — not resent, reused
    expect(result.rows[1]).not.toBe(b); // upserted — new object
  });

  test("multiple unresolvable ids are all reported", () => {
    const result = mergeKeyedDelta([{ id: "A", v: 1 }], new Map(), ["A", "X", "Y"], keyOf);
    expect(result).toEqual({ kind: "drift", missingIds: ["X", "Y"] });
  });
});

describe("mergeKeyedDelta — property (random single deltas)", () => {
  // For arbitrary (base, upserts, order): the merge is drift IFF some order id
  // is unresolvable; otherwise it equals the authoritative reconstruction and
  // is hole-free. This is the whole contract, checked over many shapes.
  test("drift iff an order id is unresolvable; else exact reconstruction, no holes", () => {
    for (let seed = 1; seed <= 2000; seed++) {
      const rand = rng(seed);
      const pick = <T,>(xs: T[]) => xs[Math.floor(rand() * xs.length)];

      // Universe of ids; base is a random subset with random versions.
      const ids = ["A", "B", "C", "D", "E", "F"];
      const base: Row[] = ids
        .filter(() => rand() < 0.6)
        .map((id) => ({ id, v: Math.floor(rand() * 5) }));

      // Upserts: random ids (some in base → update, some not → adds), new v.
      const upsertRows: Row[] = ids
        .filter(() => rand() < 0.4)
        .map((id) => ({ id, v: 100 + Math.floor(rand() * 5) }));
      const upsertMap = mapOf(upsertRows);

      // ~25% of runs use in-place mode (order undefined).
      const inPlace = rand() < 0.25;
      const order = inPlace
        ? undefined
        : // Random ordered id list: a shuffle of a random subset of the
          // universe, so it can include ids covered by neither base nor upserts.
          ids.filter(() => rand() < 0.7).sort(() => rand() - 0.5);

      const result = mergeKeyedDelta(base, upsertMap, order, keyOf);

      const baseById = mapOf(base);
      if (order === undefined) {
        // In-place can never drift and never changes length.
        const rows = expectHoleFree(result);
        expect(rows.length).toBe(base.length);
        base.forEach((b, i) => {
          expect((rows[i] as Row).id).toBe(b.id);
          expect(rows[i]).toEqual((upsertMap.get(b.id) ?? b) as Row);
        });
        continue;
      }

      const unresolved = order.filter((id) => !upsertMap.has(id) && !baseById.has(id));
      if (unresolved.length > 0) {
        expect(result).toEqual({ kind: "drift", missingIds: unresolved });
      } else {
        const rows = expectHoleFree(result);
        const expected = order.map((id) => upsertMap.get(id) ?? baseById.get(id));
        expect(rows).toEqual(expected as unknown[]);
      }
      void pick;
    }
  });
});

describe("mergeKeyedDelta — lossy-channel simulation", () => {
  // Drives the merge the way production does: a server holds the authoritative
  // list, diffs each change against its *belief* of what the client has, and
  // ships upserts (+order on membership/order change). The channel randomly
  // DROPS frames — which advances the server's belief past the client's real
  // base, the exact divergence that manufactures unresolvable ids. The client
  // resubs (full snapshot) whenever the merge reports drift.
  //
  // Invariants across the whole run: the client array is ALWAYS hole-free and
  // well-formed, the merge never throws, and once a delivered delta lands on an
  // in-sync base the client exactly equals server truth.
  test("never holes, always well-formed, converges after resub-on-drift", () => {
    for (let seed = 1; seed <= 300; seed++) {
      const rand = rng(seed);
      let nextId = 0;

      // Server truth and the server's belief of the client's content.
      let truth: Row[] = [];
      let belief = new Map<string, number>(); // id -> v as last "sent"
      let beliefOrder: string[] = [];

      // Client cache. Starts from a full base equal to truth (empty here).
      let client: Row[] = [];
      // True while the client's content matches the server's belief — i.e. no
      // outstanding dropped frame. Lets us assert exact convergence safely.
      let inSync = true;

      const assertClientWellFormed = () => {
        expect(Array.isArray(client)).toBe(true);
        for (const row of client) {
          expect(row).toBeDefined();
          expect(row).not.toBeNull();
          expect(typeof row.id).toBe("string");
          expect(typeof row.v).toBe("number");
        }
      };

      const STEPS = 60;
      for (let step = 0; step < STEPS; step++) {
        // ---- mutate truth ----
        const roll = rand();
        if (truth.length === 0 || roll < 0.4) {
          truth = [...truth, { id: `r${nextId++}`, v: 0 }]; // add
        } else if (roll < 0.65) {
          const i = Math.floor(rand() * truth.length); // update
          truth = truth.map((r, j) => (j === i ? { id: r.id, v: r.v + 1 } : r));
        } else if (roll < 0.85) {
          const i = Math.floor(rand() * truth.length); // delete
          truth = truth.filter((_, j) => j !== i);
        } else {
          truth = [...truth].sort(() => rand() - 0.5); // reorder
        }

        // ---- server computes delta vs its belief, then advances belief ----
        const upserts: [string, unknown][] = [];
        for (const r of truth) {
          if (belief.get(r.id) !== r.v) upserts.push([r.id, { id: r.id, v: r.v }]);
        }
        const truthOrder = truth.map((r) => r.id);
        const membershipOrOrderChanged =
          truthOrder.length !== beliefOrder.length ||
          truthOrder.some((id, i) => beliefOrder[i] !== id);
        const order = membershipOrOrderChanged ? truthOrder : undefined;

        belief = new Map(truth.map((r) => [r.id, r.v]));
        beliefOrder = truthOrder;

        // ---- channel: deliver or drop ----
        const delivered = rand() < 0.8;
        if (!delivered) {
          // Client base now lags the server belief: divergence seeded.
          inSync = false;
          assertClientWellFormed();
          continue;
        }

        const wasInSync = inSync;
        const result = mergeKeyedDelta(client, new Map(upserts), order, keyOf);
        if (result.kind === "drift") {
          // Resub: server ships a fresh full base = current truth.
          client = truth.map((r) => ({ id: r.id, v: r.v }));
          inSync = true;
        } else {
          client = result.rows.map((r) => ({ id: (r as Row).id, v: (r as Row).v }));
          // A delivered delta onto an in-sync base must reproduce truth exactly.
          if (wasInSync) {
            expect(result.kind).toBe("merged");
            expect(client).toEqual(truth);
            inSync = true;
          } else {
            // Off a diverged base the merge may stay stale (no version guard in
            // this unit) — tolerated, as long as it's hole-free. It self-heals
            // on the next drift-triggered resub.
            inSync = JSON.stringify(client) === JSON.stringify(truth);
          }
        }
        assertClientWellFormed();
      }

      // Final heal: a guaranteed-delivered full snapshot (every row upserted)
      // must reconstruct truth from whatever base the client holds.
      const fullUpserts: [string, unknown][] = truth.map((r) => [r.id, { id: r.id, v: r.v }]);
      const healed = mergeKeyedDelta(client, new Map(fullUpserts), truth.map((r) => r.id), keyOf);
      expect(healed.kind).toBe("merged");
      if (healed.kind === "merged") {
        expect(healed.rows.map((r) => ({ id: (r as Row).id, v: (r as Row).v }))).toEqual(truth);
      }
    }
  });
});
