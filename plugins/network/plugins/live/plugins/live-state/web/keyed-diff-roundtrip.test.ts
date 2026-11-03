/**
 * ROUND-TRIP property: the SERVER keyed-delta producer and the CLIENT merge
 * consumer agree on ONE contract. Run with
 * `bun test plugins/network/plugins/live/plugins/live-state/web/keyed-diff-roundtrip.test.ts`.
 *
 * The server `diffKeyedFull` / `diffKeyedScoped`
 * (`@plugins/network/plugins/live/plugins/resource-runtime/core/testing`) emit `(upserts, deletes,
 * order)` deltas; the client `mergeKeyedDelta` (local) consumes them to rebuild
 * the array. This test proves: for ANY random mutation (add / update / delete /
 * reorder, and scoped partial recomputes), feeding the diff's output into the
 * merge reconstructs the server's `next` array EXACTLY — same ids, same order,
 * same content. A divergence in either half (a dropped delete, a wrongly-omitted
 * order, a stale upsert) breaks reconstruction.
 *
 * Import direction: live-state is DOWNSTREAM of resource-runtime, so it may
 * import the framework-core diff (published for this suite from its testing
 * barrel); the reverse would invert the dependency. The
 * client merge is imported locally. (The diff-only invariants live inside
 * resource-runtime itself — `core/keyed-diff.test.ts`.)
 */

import { test, expect, describe } from "bun:test";
import {
  buildSnapshot,
  diffKeyedFull,
  diffKeyedScoped,
  hashSnapEncoder,
  type KeyedSnapshot,
} from "@plugins/network/plugins/live/plugins/resource-runtime/core/testing";

// The round-trip only exercises wire frames (upserts/order), never snapshot
// contents, so one representative encoder suffices; the per-encoder diff
// invariants are pinned server-side in keyed-diff.test.ts.
const enc = hashSnapEncoder;
import { mergeKeyedDelta } from "./keyed-delta-merge";

type Row = { id: string; v: number };
const keyOf = (r: unknown) => (r as Row).id;

// Deterministic PRNG (mulberry32) — a fuzz failure replays from its seed.
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

// Apply a server FULL diff to a client base via the client merge, asserting the
// result reconstructs `next` exactly. Returns the rebuilt rows (the new base).
function applyFull(
  clientRows: Row[],
  prevSnap: KeyedSnapshot | undefined,
  next: Row[],
): Row[] {
  const { diff } = diffKeyedFull(prevSnap, next, keyOf, enc);
  const upsertMap = new Map<string, unknown>(diff.upserts);
  // The client merge consumes `order` + `upserts`. A FULL diff that omits order
  // (in-place) still applies via the order-undefined branch. Deletes are encoded
  // by order: an omitted id is simply not in `order`. For the in-place branch
  // (order undefined) deletes are guaranteed empty by the producer's contract.
  const result = mergeKeyedDelta(clientRows, upsertMap, diff.order, keyOf);
  expect(result.kind).toBe("merged");
  if (result.kind !== "merged") throw new Error("unreachable");
  const rebuilt = result.rows as Row[];
  // Exact reconstruction: ids, order, and content all equal `next`.
  expect(rebuilt).toEqual(next);
  return rebuilt;
}

describe("server diff → client merge round-trip (FULL diffs)", () => {
  test("single transition kinds reconstruct exactly", () => {
    // add
    {
      const prev: Row[] = [{ id: "A", v: 1 }];
      const out = applyFull(prev, buildSnapshot(prev, keyOf, enc), [
        { id: "A", v: 1 },
        { id: "B", v: 2 },
      ]);
      expect(out).toEqual([
        { id: "A", v: 1 },
        { id: "B", v: 2 },
      ]);
    }
    // update (in-place; order omitted)
    {
      const prev: Row[] = [
        { id: "A", v: 1 },
        { id: "B", v: 1 },
      ];
      applyFull(prev, buildSnapshot(prev, keyOf, enc), [
        { id: "A", v: 1 },
        { id: "B", v: 9 },
      ]);
    }
    // delete
    {
      const prev: Row[] = [
        { id: "A", v: 1 },
        { id: "B", v: 1 },
      ];
      applyFull(prev, buildSnapshot(prev, keyOf, enc), [{ id: "A", v: 1 }]);
    }
    // reorder
    {
      const prev: Row[] = [
        { id: "A", v: 1 },
        { id: "B", v: 1 },
        { id: "C", v: 1 },
      ];
      applyFull(prev, buildSnapshot(prev, keyOf, enc), [
        { id: "C", v: 1 },
        { id: "A", v: 1 },
        { id: "B", v: 1 },
      ]);
    }
  });

  // The high-value test: a long correlated sequence of random mutations. The
  // server holds truth + its snapshot; each step it diffs truth→next, the client
  // merges the delta onto its base, and we assert client === truth after EVERY
  // step. This exercises every transition kind in combination and proves the
  // producer and consumer never drift across a realistic stream.
  test("random correlated mutation streams reconstruct truth at every step", () => {
    for (let seed = 1; seed <= 1200; seed++) {
      const rand = rng(seed);
      let nextId = 0;

      // Server truth + its per-pk snapshot (id→hash).
      let truth: Row[] = [];
      let snapshot: KeyedSnapshot = new Map();
      // Client base, kept in lock-step via merges.
      let client: Row[] = [];

      const STEPS = 40;
      for (let step = 0; step < STEPS; step++) {
        const roll = rand();
        if (truth.length === 0 || roll < 0.4) {
          // add (sometimes at a random position, so order varies)
          const row = { id: `r${nextId++}`, v: 0 };
          const at = Math.floor(rand() * (truth.length + 1));
          truth = [...truth.slice(0, at), row, ...truth.slice(at)];
        } else if (roll < 0.65) {
          const i = Math.floor(rand() * truth.length); // update
          truth = truth.map((r, j) => (j === i ? { id: r.id, v: r.v + 1 } : r));
        } else if (roll < 0.85) {
          const i = Math.floor(rand() * truth.length); // delete
          truth = truth.filter((_, j) => j !== i);
        } else {
          truth = [...truth].sort(() => rand() - 0.5); // reorder
        }

        // Server diffs truth against its snapshot, advancing the snapshot.
        const { diff, nextSnapshot } = diffKeyedFull(
          snapshot,
          truth,
          keyOf,
          enc,
        );
        snapshot = nextSnapshot;

        // Client merges the delta onto its base.
        const upsertMap = new Map<string, unknown>(diff.upserts);
        const result = mergeKeyedDelta(client, upsertMap, diff.order, keyOf);
        expect(result.kind).toBe("merged");
        if (result.kind !== "merged") throw new Error("unreachable");
        client = (result.rows as Row[]).map((r) => ({ id: r.id, v: r.v }));

        // Exact agreement after every single step.
        expect(client).toEqual(truth);
      }
    }
  });
});

describe("server scoped diff → client merge round-trip (Layer 2)", () => {
  // A scoped diff ships `{ upserts, deletes: [], order: undefined }` — a pure
  // in-place content delta. After the client merges it, the changed rows must
  // reflect the recompute and membership/order must be untouched. We assert the
  // client equals the snapshot-implied truth (base with the scoped rows applied).
  test("random partial recomputes apply in place, membership/order preserved", () => {
    for (let seed = 1; seed <= 1200; seed++) {
      const rand = rng(seed);
      const ids = ["A", "B", "C", "D", "E"];
      const base: Row[] = ids
        .filter(() => rand() < 0.7)
        .map((id) => ({ id, v: Math.floor(rand() * 4) }));
      if (base.length === 0) continue;
      const snapshot = buildSnapshot(base, keyOf, enc);

      // Client starts in sync with the base.
      const client: Row[] = base.map((r) => ({ ...r }));

      // Recompute a random subset of existing ids, with random new versions.
      const scoped: Row[] = base
        .filter(() => rand() < 0.5)
        .map((r) => ({ id: r.id, v: rand() < 0.4 ? r.v : r.v + 10 }));

      const { upserts } = diffKeyedScoped(snapshot, scoped, keyOf, enc);

      // Expected client truth: the base with the scoped rows overlaid (same
      // membership + order — scoped never moves or removes rows).
      const overlay = new Map(scoped.map((r) => [r.id, r] as [string, Row]));
      const expected = base.map((r) => overlay.get(r.id) ?? r);

      const result = mergeKeyedDelta(
        client,
        new Map<string, unknown>(upserts),
        undefined, // scoped diff omits order — pure in-place
        keyOf,
      );
      expect(result.kind).toBe("merged");
      if (result.kind !== "merged") throw new Error("unreachable");
      expect(result.rows as Row[]).toEqual(expected);
    }
  });
});
