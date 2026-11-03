/**
 * Tests for the SERVER-side keyed-delta diff core. Run with
 * `bun test plugins/network/plugins/live/plugins/resource-runtime/core/keyed-diff.test.ts`.
 *
 * This is the producer of the `(upserts, deletes, order)` deltas the client
 * `mergeKeyedDelta` consumes. The round-trip property (producer ⟷ consumer
 * agree on one contract) lives in the live-state plugin
 * (`keyed-diff-roundtrip.test.ts`) — it needs both halves, and the import
 * direction only allows live-state to depend on resource-runtime, never the
 * reverse. This file tests the diff's standalone invariants:
 *
 *   - `order` is asserted IFF membership/order changed; omitted strictly means
 *     "in-place upserts, membership unchanged" ⇒ then `deletes` is empty AND no
 *     new ids appear.
 *   - `upserts` = exactly the rows whose content identity changed plus the new
 *     rows.
 *   - `deletes` = exactly the ids removed since the prior snapshot.
 *   - The scoped (Layer-2) variant NEVER asserts order/deletes; membership stays
 *     FULL. Its upserts are exactly the changed rows in the partial input.
 *   - Both functions are pure: they never mutate the prior snapshot.
 *
 * Every suite runs under BOTH snapshot encoders (`hashSnapEncoder` — the
 * default 64-bit content hash — and `retainSnapEncoder` — the canonical-JSON
 * retention `scopedMembership` entries use), so the two representations are
 * pinned by identical scenarios and the same fuzz oracle. A final suite
 * documents the hash encoder's one new failure mode: a forced collision makes
 * a changed row read as unchanged (see `hashSnapEncoder`'s doc comment for the
 * birthday bound that makes this acceptable).
 */

import { test, expect, describe } from "bun:test";
import {
  buildSnapshot,
  diffKeyedFull,
  diffKeyedScoped,
  diffKeyedScopedMembership,
  hashSnapEncoder,
  retainSnapEncoder,
  type KeyedSnapshot,
  type SnapEncoder,
} from "./keyed-diff";
// mulberry32 PRNG + the faithful client-view simulator are single-sourced in
// test-support (deduped from here).
import { rng, makeClientView, type RecordedFrame } from "./test-support";

type Row = { id: string; v: number };
const keyOf = (r: unknown) => (r as Row).id;

const ENCODERS: [string, SnapEncoder][] = [
  ["hash", hashSnapEncoder],
  ["retain", retainSnapEncoder],
];

for (const [encName, enc] of ENCODERS) {
  const snapOf = (rows: Row[]) => buildSnapshot(rows, keyOf, enc);
  // The encoded identity of a row — what the snapshot is expected to store.
  const idOf = (row: unknown) => enc(JSON.stringify(row));

  describe(`diffKeyedFull — scenarios [${encName}]`, () => {
    test("first notify (no prior snapshot): hadSnapshot false, all rows upserted, order asserted", () => {
      const { diff, nextSnapshot } = diffKeyedFull(undefined, [{ id: "A", v: 1 }, { id: "B", v: 1 }], keyOf, enc);
      expect(diff.hadSnapshot).toBe(false);
      expect(diff.upserts.map(([id]) => id)).toEqual(["A", "B"]);
      expect(diff.deletes).toEqual([]);
      expect(diff.order).toEqual(["A", "B"]);
      expect([...nextSnapshot.keys()]).toEqual(["A", "B"]);
    });

    test("in-place content change: order omitted, deletes empty, only changed row upserted", () => {
      const prev = snapOf([{ id: "A", v: 1 }, { id: "B", v: 1 }]);
      const { diff } = diffKeyedFull(prev, [{ id: "A", v: 1 }, { id: "B", v: 2 }], keyOf, enc);
      expect(diff.order).toBeUndefined();
      expect(diff.deletes).toEqual([]);
      expect(diff.upserts).toEqual([["B", { id: "B", v: 2 }]]);
      expect(diff.hadSnapshot).toBe(true);
    });

    test("no change at all: order omitted, no upserts, no deletes", () => {
      const prev = snapOf([{ id: "A", v: 1 }, { id: "B", v: 1 }]);
      const { diff } = diffKeyedFull(prev, [{ id: "A", v: 1 }, { id: "B", v: 1 }], keyOf, enc);
      expect(diff.order).toBeUndefined();
      expect(diff.upserts).toEqual([]);
      expect(diff.deletes).toEqual([]);
    });

    test("membership add: order asserted, new row upserted, deletes empty", () => {
      const prev = snapOf([{ id: "A", v: 1 }]);
      const { diff } = diffKeyedFull(prev, [{ id: "A", v: 1 }, { id: "B", v: 1 }], keyOf, enc);
      expect(diff.order).toEqual(["A", "B"]);
      expect(diff.upserts).toEqual([["B", { id: "B", v: 1 }]]);
      expect(diff.deletes).toEqual([]);
    });

    test("membership delete: order asserted, deletes names the removed id, no upserts", () => {
      const prev = snapOf([{ id: "A", v: 1 }, { id: "B", v: 1 }]);
      const { diff } = diffKeyedFull(prev, [{ id: "A", v: 1 }], keyOf, enc);
      expect(diff.order).toEqual(["A"]);
      expect(diff.deletes).toEqual(["B"]);
      expect(diff.upserts).toEqual([]);
    });

    test("pure reorder (no content change): order asserted, no upserts, no deletes", () => {
      const prev = snapOf([{ id: "A", v: 1 }, { id: "B", v: 1 }, { id: "C", v: 1 }]);
      const { diff } = diffKeyedFull(prev, [{ id: "C", v: 1 }, { id: "A", v: 1 }, { id: "B", v: 1 }], keyOf, enc);
      expect(diff.order).toEqual(["C", "A", "B"]);
      expect(diff.upserts).toEqual([]);
      expect(diff.deletes).toEqual([]);
    });

    test("does not mutate the prior snapshot", () => {
      const prev = snapOf([{ id: "A", v: 1 }, { id: "B", v: 1 }]);
      const before = new Map(prev);
      diffKeyedFull(prev, [{ id: "A", v: 9 }], keyOf, enc);
      expect(prev).toEqual(before);
    });
  });

  describe(`diffKeyedScoped — scenarios [${encName}]`, () => {
    test("never asserts order/deletes; upserts only the changed partial rows", () => {
      const prev = snapOf([{ id: "A", v: 1 }, { id: "B", v: 1 }, { id: "C", v: 1 }]);
      // Partial recompute: only B and C were recomputed; B changed, C didn't.
      const { upserts, nextSnapshot } = diffKeyedScoped(prev, [{ id: "B", v: 2 }, { id: "C", v: 1 }], keyOf, enc);
      expect(upserts).toEqual([["B", { id: "B", v: 2 }]]);
      // Snapshot still has all three ids, A and C untouched, B updated.
      expect([...nextSnapshot.keys()]).toEqual(["A", "B", "C"]);
      expect(nextSnapshot.get("B")).toBe(idOf({ id: "B", v: 2 }));
      expect(nextSnapshot.get("A")).toBe(idOf({ id: "A", v: 1 }));
    });

    test("does not mutate the prior snapshot", () => {
      const prev = snapOf([{ id: "A", v: 1 }, { id: "B", v: 1 }]);
      const before = new Map(prev);
      diffKeyedScoped(prev, [{ id: "B", v: 5 }], keyOf, enc);
      expect(prev).toEqual(before);
    });
  });

  describe(`diffKeyedFull — property (random prev→next transitions) [${encName}]`, () => {
    // A random list of rows over a small id universe with random versions.
    function randomRows(rand: () => number, ids: string[]): Row[] {
      return ids
        .filter(() => rand() < 0.6)
        .map((id) => ({ id, v: Math.floor(rand() * 4) }))
        // shuffle so order varies independently of membership
        .sort(() => rand() - 0.5);
    }

    // For arbitrary prev/next lists, every wire invariant holds, derived directly
    // from the two snapshots (no reimplementation of the diff's internals).
    test("order iff membership/order changed; deletes=removed; upserts=changed∪new", () => {
      let checks = 0;
      for (let seed = 1; seed <= 3000; seed++) {
        const rand = rng(seed);
        const ids = ["A", "B", "C", "D", "E"];

        // ~15% of runs exercise the first-notify (no prior snapshot) path.
        const firstNotify = rand() < 0.15;
        const prevRows = firstNotify ? null : randomRows(rand, ids);
        const prev: KeyedSnapshot | undefined = prevRows ? snapOf(prevRows) : undefined;
        const nextRows = randomRows(rand, ids);

        const { diff, nextSnapshot } = diffKeyedFull(prev, nextRows, keyOf, enc);

        const prevById = new Map((prevRows ?? []).map((r) => [r.id, idOf(r)]));
        const prevOrder = prevRows ? prevRows.map((r) => r.id) : undefined;
        const nextOrder = nextRows.map((r) => r.id);

        // hadSnapshot mirrors whether a prior snapshot existed.
        expect(diff.hadSnapshot).toBe(prev !== undefined);

        // --- order: asserted IFF membership/order changed (vs prior) ---
        const orderChanged =
          prevOrder === undefined ||
          prevOrder.length !== nextOrder.length ||
          prevOrder.some((id, i) => id !== nextOrder[i]);
        if (orderChanged) {
          expect(diff.order).toEqual(nextOrder);
        } else {
          expect(diff.order).toBeUndefined();
          // Omitted order strictly means membership unchanged ⇒ no deletes, no new ids.
          expect(diff.deletes).toEqual([]);
          for (const [id] of diff.upserts) expect(prevById.has(id)).toBe(true);
        }

        // --- deletes: exactly the ids in prev absent from next ---
        const expectedDeletes = [...prevById.keys()].filter((id) => !nextOrder.includes(id));
        expect([...diff.deletes].sort()).toEqual(expectedDeletes.sort());

        // --- upserts: exactly the rows whose identity differs from prev (or are new) ---
        const expectedUpsertIds = nextRows
          .filter((r) => prevById.get(r.id) !== idOf(r))
          .map((r) => r.id);
        expect(diff.upserts.map(([id]) => id).sort()).toEqual(expectedUpsertIds.sort());
        // Every upsert carries the actual current row object.
        for (const [id, row] of diff.upserts) {
          expect(JSON.stringify(row)).toBe(JSON.stringify(nextRows.find((r) => r.id === id)));
        }

        // --- nextSnapshot reflects the new array exactly (id order + identities) ---
        expect([...nextSnapshot.keys()]).toEqual(nextOrder);
        for (const r of nextRows) expect(nextSnapshot.get(r.id)).toBe(idOf(r));

        checks++;
      }
      expect(checks).toBe(3000);
    });
  });

  describe(`diffKeyedScoped — property (random partial recomputes) [${encName}]`, () => {
    test("upserts = exactly changed partial rows; snapshot merges, prev untouched, no order/deletes", () => {
      for (let seed = 1; seed <= 2000; seed++) {
        const rand = rng(seed);
        const ids = ["A", "B", "C", "D", "E"];
        const baseRows = ids
          .filter(() => rand() < 0.7)
          .map((id) => ({ id, v: Math.floor(rand() * 4) }));
        if (baseRows.length === 0) continue;
        const prev = snapOf(baseRows);
        const prevCopy = new Map(prev);

        // Partial recompute: a random subset of the base ids, each possibly changed.
        const scoped: Row[] = baseRows
          .filter(() => rand() < 0.5)
          .map((r) => ({ id: r.id, v: rand() < 0.5 ? r.v : r.v + 10 }));

        const { upserts, nextSnapshot } = diffKeyedScoped(prev, scoped, keyOf, enc);

        // prev never mutated.
        expect(prev).toEqual(prevCopy);

        // upserts = exactly the scoped rows whose identity differs from prev.
        const expected = scoped
          .filter((r) => prevCopy.get(r.id) !== idOf(r))
          .map((r) => [r.id, r] as [string, Row]);
        expect(upserts.map(([id]) => id)).toEqual(expected.map(([id]) => id));
        for (const [id, row] of upserts) {
          expect(JSON.stringify(row)).toBe(JSON.stringify(scoped.find((r) => r.id === id)));
        }

        // Membership preserved: nextSnapshot keys = prev keys (scoped never adds/removes).
        expect([...nextSnapshot.keys()].sort()).toEqual([...prevCopy.keys()].sort());
        // Untouched ids keep their prior identity; scoped-changed ids get the new one.
        for (const id of prevCopy.keys()) {
          const scopedRow = scoped.find((r) => r.id === id);
          const expectedEntry =
            scopedRow && prevCopy.get(id) !== idOf(scopedRow)
              ? idOf(scopedRow)
              : prevCopy.get(id);
          expect(nextSnapshot.get(id)).toBe(expectedEntry!);
        }
      }
    });
  });

  // --- M5: membership-aware scoped diff ---------------------------------------

  describe(`diffKeyedScopedMembership — scenarios [${encName}]`, () => {
    const set = (...ids: string[]) => new Set(ids);

    test("pure delete: no refill, delete + order shipped, snapshot loses the id", () => {
      const prev = snapOf([{ id: "A", v: 1 }, { id: "B", v: 1 }, { id: "C", v: 1 }]);
      const r = diffKeyedScopedMembership(prev, [], { requestedIds: set(), deletedIds: set("B") }, keyOf, enc);
      expect(r.upserts).toEqual([]);
      expect(r.deletes).toEqual(["B"]);
      expect(r.order).toEqual(["A", "C"]);
      expect([...r.nextSnapshot.keys()]).toEqual(["A", "C"]);
    });

    test("where-flip exit: a requested id absent from the refill leaves membership (no orderedIds needed)", () => {
      const prev = snapOf([{ id: "A", v: 1 }, { id: "B", v: 1 }]);
      // A's `where` flipped false → the refill of {A} returns nothing.
      const r = diffKeyedScopedMembership(prev, [], { requestedIds: set("A"), deletedIds: set() }, keyOf, enc);
      expect(r.upserts).toEqual([]);
      expect(r.deletes).toEqual(["A"]);
      expect(r.order).toEqual(["B"]);
      expect([...r.nextSnapshot.keys()]).toEqual(["B"]);
    });

    test("insert entering at position: orderedIds places the new row; upsert + order shipped", () => {
      const prev = snapOf([{ id: "A", v: 1 }, { id: "C", v: 1 }]);
      const r = diffKeyedScopedMembership(
        prev,
        [{ id: "B", v: 1 }],
        { requestedIds: set("B"), deletedIds: set(), orderedIds: ["A", "B", "C"] },
        keyOf,
        enc,
      );
      expect(r.upserts).toEqual([["B", { id: "B", v: 1 }]]);
      expect(r.deletes).toEqual([]);
      expect(r.order).toEqual(["A", "B", "C"]);
      expect([...r.nextSnapshot.keys()]).toEqual(["A", "B", "C"]);
    });

    test("insert-then-delete of a brand-new id (coalesced): no-op, order omitted", () => {
      const prev = snapOf([{ id: "A", v: 1 }]);
      // X was inserted then deleted in one flush: requested ∪ deleted both name it,
      // but it is in neither prev nor the refill → nothing happens.
      const r = diffKeyedScopedMembership(prev, [], { requestedIds: set("X"), deletedIds: set("X") }, keyOf, enc);
      expect(r.upserts).toEqual([]);
      expect(r.deletes).toEqual([]);
      expect(r.order).toBeUndefined();
      expect([...r.nextSnapshot.keys()]).toEqual(["A"]);
    });

    test("delete-then-reinsert of an existing id (coalesced): plain in-place upsert, order omitted", () => {
      const prev = snapOf([{ id: "A", v: 1 }, { id: "B", v: 1 }]);
      // A deleted then reinserted with new content: still a member, still in place.
      const r = diffKeyedScopedMembership(
        prev,
        [{ id: "A", v: 2 }],
        { requestedIds: set("A"), deletedIds: set("A") },
        keyOf,
        enc,
      );
      expect(r.upserts).toEqual([["A", { id: "A", v: 2 }]]);
      expect(r.deletes).toEqual([]);
      expect(r.order).toBeUndefined();
      expect([...r.nextSnapshot.keys()]).toEqual(["A", "B"]);
      expect(r.nextSnapshot.get("A")).toBe(idOf({ id: "A", v: 2 }));
    });

    test("reactivation entry (where-flip false→true): treated as an entry, placed via orderedIds", () => {
      const prev = snapOf([{ id: "A", v: 1 }]);
      // B existed with where=false (not a member); an UPDATE flipped it true.
      const r = diffKeyedScopedMembership(
        prev,
        [{ id: "B", v: 5 }],
        { requestedIds: set("B"), deletedIds: set(), orderedIds: ["A", "B"] },
        keyOf,
        enc,
      );
      expect(r.upserts).toEqual([["B", { id: "B", v: 5 }]]);
      expect(r.deletes).toEqual([]);
      expect(r.order).toEqual(["A", "B"]);
      expect([...r.nextSnapshot.keys()]).toEqual(["A", "B"]);
    });

    test("unknown orderedIds id (in the order list but neither refilled nor prev): dropped from order + snapshot", () => {
      const prev = snapOf([{ id: "A", v: 1 }]);
      const r = diffKeyedScopedMembership(
        prev,
        [{ id: "B", v: 1 }],
        { requestedIds: set("B"), deletedIds: set(), orderedIds: ["A", "B", "Z"] },
        keyOf,
        enc,
      );
      expect(r.order).toEqual(["A", "B"]); // Z is unresolvable → dropped
      expect([...r.nextSnapshot.keys()]).toEqual(["A", "B"]);
    });

    test("requested id absent from both snapshot and refill (insert filtered by where): no-op", () => {
      const prev = snapOf([{ id: "A", v: 1 }]);
      const r = diffKeyedScopedMembership(prev, [], { requestedIds: set("B"), deletedIds: set() }, keyOf, enc);
      expect(r.upserts).toEqual([]);
      expect(r.deletes).toEqual([]);
      expect(r.order).toBeUndefined();
      expect([...r.nextSnapshot.keys()]).toEqual(["A"]);
    });

    test("in-place update (member content change, no membership change): order omitted, only the changed row upserted", () => {
      const prev = snapOf([{ id: "A", v: 1 }, { id: "B", v: 1 }]);
      const r = diffKeyedScopedMembership(
        prev,
        [{ id: "B", v: 2 }],
        { requestedIds: set("B"), deletedIds: set() },
        keyOf,
        enc,
      );
      expect(r.upserts).toEqual([["B", { id: "B", v: 2 }]]);
      expect(r.deletes).toEqual([]);
      expect(r.order).toBeUndefined();
      expect(r.nextSnapshot.get("B")).toBe(idOf({ id: "B", v: 2 }));
    });

    test("does not mutate the prior snapshot", () => {
      const prev = snapOf([{ id: "A", v: 1 }, { id: "B", v: 1 }]);
      const before = new Map(prev);
      diffKeyedScopedMembership(prev, [], { requestedIds: set(), deletedIds: set("B") }, keyOf, enc);
      expect(prev).toEqual(before);
    });
  });

  /**
   * Property fuzz: random INSERT/UPDATE/DELETE/where-flip op batches over a
   * simulated table. Each batch is applied incrementally through
   * `diffKeyedScopedMembership` and, independently, FULL-recomputed through the
   * `diffKeyedFull` ORACLE over the true membership. The two must agree on the
   * snapshot (id order + identities) after every batch, AND the incremental
   * frames fed to the real client-view simulator must converge to true
   * membership with ZERO drift-resubs — i.e. the incremental path is
   * observationally identical to always FULL-recomputing.
   */
  describe(`diffKeyedScopedMembership — property (random op batches vs FULL oracle) [${encName}]`, () => {
    interface Cell {
      n: number;
      where: boolean;
    }
    type MRow = { id: string; n: number };
    const IDS = ["A", "B", "C", "D", "E", "F"];

    test("incremental snapshot ≡ FULL oracle; client converges with zero drift", () => {
      let totalBatches = 0;
      for (let seed = 1; seed <= 200; seed++) {
        const rand = rng(seed);
        const table = new Map<string, Cell>();
        // Random initial membership (some where=true, some in-table-but-false).
        for (const id of IDS) {
          if (rand() < 0.5) table.set(id, { n: Math.floor(rand() * 4), where: rand() < 0.6 });
        }

        const rowOf = (id: string): MRow => ({ id, n: table.get(id)!.n });
        const sortedMembers = (): string[] =>
          [...table.entries()].filter(([, c]) => c.where).map(([id]) => id).sort();
        const memberRows = (): MRow[] => sortedMembers().map(rowOf);
        const snap = (rows: MRow[]) => buildSnapshot(rows, keyOf, enc);

        // Seed both snapshots + the client from the initial membership.
        let membershipSnap: KeyedSnapshot = snap(memberRows());
        let oracleSnap: KeyedSnapshot = snap(memberRows());
        const client = makeClientView(keyOf);
        let version = 0;
        client.apply({ seq: 0, socket: 0, kind: "update", key: "k", version, value: memberRows() });

        for (let step = 0; step < 20; step++) {
          const requestedIds = new Set<string>();
          const deletedIds = new Set<string>();
          const ops = 1 + Math.floor(rand() * 3);
          for (let o = 0; o < ops; o++) {
            const roll = rand();
            const inTable = [...table.keys()];
            const notInTable = IDS.filter((id) => !table.has(id));
            if (roll < 0.4 && notInTable.length > 0) {
              // INSERT a new row (maybe a non-member if where=false).
              const id = notInTable[Math.floor(rand() * notInTable.length)]!;
              table.set(id, { n: Math.floor(rand() * 4), where: rand() < 0.65 });
              requestedIds.add(id);
            } else if (roll < 0.8 && inTable.length > 0) {
              // UPDATE: change content and/or flip `where` (entry/exit).
              const id = inTable[Math.floor(rand() * inTable.length)]!;
              const cell = table.get(id)!;
              table.set(id, {
                n: rand() < 0.5 ? cell.n : cell.n + 1,
                where: rand() < 0.5 ? cell.where : !cell.where,
              });
              requestedIds.add(id);
            } else if (inTable.length > 0) {
              // DELETE.
              const id = inTable[Math.floor(rand() * inTable.length)]!;
              table.delete(id);
              deletedIds.add(id);
            }
          }
          if (requestedIds.size === 0 && deletedIds.size === 0) continue;

          // The refill: rows for the requested ids that STILL match `where=true`.
          const refillRows = [...requestedIds]
            .filter((id) => table.get(id)?.where)
            .map(rowOf);
          const refillIds = new Set(refillRows.map((r) => r.id));
          // orderedIds only when a refilled id entered membership.
          let entered = false;
          for (const id of refillIds) if (!membershipSnap.has(id)) entered = true;
          const orderedIds = entered ? sortedMembers() : undefined;

          const result = diffKeyedScopedMembership(
            membershipSnap,
            refillRows,
            { requestedIds, deletedIds, orderedIds },
            keyOf,
            enc,
          );
          membershipSnap = result.nextSnapshot;

          // FULL oracle over the true membership, in the same (sorted) order.
          const oracle = diffKeyedFull(oracleSnap, memberRows(), keyOf, enc);
          oracleSnap = oracle.nextSnapshot;

          // (1) Incremental snapshot ≡ FULL oracle (id order AND identities).
          expect([...membershipSnap.entries()]).toEqual([...oracleSnap.entries()]);

          // (2) Client converges: ship a delta only on a real change (mirrors the
          // runtime's "empty diff → no frame, no version bump").
          const changed = result.upserts.length > 0 || result.deletes.length > 0;
          if (changed) {
            version++;
            const frame: RecordedFrame = {
              seq: 0,
              socket: 0,
              kind: "delta",
              key: "k",
              version,
              upserts: result.upserts,
              deletes: result.deletes,
              order: result.order,
            };
            client.apply(frame);
          }
          expect(client.driftResubs).toBe(0);
          expect(client.value).toEqual(memberRows());
          totalBatches++;
        }
      }
      expect(totalBatches).toBeGreaterThan(1000);
    });
  });
}

// --- hash encoder specifics ---------------------------------------------------

describe("hashSnapEncoder", () => {
  test("distinct canonical JSON encodes to distinct entries (spot check + length fold)", () => {
    // Same length, different content — relies on wyhash.
    expect(hashSnapEncoder('{"id":"A","v":1}')).not.toBe(hashSnapEncoder('{"id":"A","v":2}'));
    // Different length — killed by the length fold even under a wyhash collision.
    expect(hashSnapEncoder('{"id":"A"}')).not.toBe(hashSnapEncoder('{"id":"AB"}'));
    // Deterministic.
    expect(hashSnapEncoder('{"id":"A","v":1}')).toBe(hashSnapEncoder('{"id":"A","v":1}'));
  });

  test("COLLISION FAILURE MODE (documented): a colliding encoder makes a changed row read as unchanged", () => {
    // Force the collision the 64-bit hash makes astronomically unlikely
    // (~n²/2⁶⁵ per pk — see hashSnapEncoder's doc): a constant encoder. The
    // diff then sees no change — no upsert, no frame, no self-heal. This test
    // exists to DOCUMENT the failure shape the hash trade accepts, so a future
    // reader finds it pinned rather than discovering it in production.
    const colliding: SnapEncoder = () => 0n;
    const prev = buildSnapshot([{ id: "A", v: 1 }], keyOf, colliding);
    const { diff } = diffKeyedFull(prev, [{ id: "A", v: 2 }], keyOf, colliding);
    expect(diff.upserts).toEqual([]); // the changed row is silently missed
  });
});
