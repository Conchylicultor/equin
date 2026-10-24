/**
 * Real-DB suite for the BOUNDED row-order upsert. Drives the db-parametrized
 * `applyRowOrder` against a throwaway Postgres (db-test-fixture) with the REAL
 * migration chain applied — the `ON CONFLICT` upsert and the `rank_text`
 * (C-collation) ordering are exactly what production runs.
 *
 * The headline behaviour vs the old full-replace handler: a key absent from
 * `writes` **survives** — nothing is deleted.
 *
 * Requires the running embedded cluster AND the `data_view_row_order` migration
 * (i.e. `./equin build` first):
 *
 *   bun test plugins/primitives/plugins/data-view/plugins/view-order/server
 */

import {
  describe,
  test,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
} from "bun:test";
import { and, asc, eq } from "drizzle-orm";
import {
  createTestDb,
  type TestDb,
} from "@plugins/database/plugins/db-test-fixture/server/testing";
import { runMigrations } from "@plugins/database/plugins/migrations/server/testing";
import { HttpError } from "@plugins/infra/plugins/endpoints/core";
import { Rank } from "@plugins/primitives/plugins/rank/core";
import type { RowOrderWrite } from "../../core/internal/order-ops";
import { _dataViewRowOrder } from "./tables";
import { applyRowOrder } from "./handle-set-row-order";

let t: TestDb;

const DATA_VIEW_ID = "test.surface";
const VIEW_ID = "view-1";

beforeAll(async () => {
  t = await createTestDb({ prefix: "dvro_test" });
  await runMigrations(t.db);
});

afterAll(async () => {
  await t.drop();
});

beforeEach(async () => {
  await t.db.delete(_dataViewRowOrder);
});

/** The persisted keys of one scope, rank-ascending — the displayed order. */
async function readOrder(viewId = VIEW_ID): Promise<string[]> {
  const rows = await t.db
    .select({ rowKey: _dataViewRowOrder.rowKey })
    .from(_dataViewRowOrder)
    .where(
      and(
        eq(_dataViewRowOrder.dataViewId, DATA_VIEW_ID),
        eq(_dataViewRowOrder.viewId, viewId),
      ),
    )
    .orderBy(asc(_dataViewRowOrder.rank));
  return rows.map((r) => r.rowKey);
}

/** Dense, strictly-ascending writes for `order` — a valid bounded write set. */
function mkWrites(order: readonly string[]): RowOrderWrite[] {
  const ranks = Rank.nBetween(null, null, order.length);
  return order.map((rowKey, i): RowOrderWrite => ({ rowKey, rank: ranks[i]! }));
}

/** Upsert a bounded write set. */
function apply(writes: RowOrderWrite[], viewId = VIEW_ID): Promise<void> {
  return applyRowOrder(t.db, { dataViewId: DATA_VIEW_ID, viewId, writes });
}

describe("applyRowOrder (bounded upsert)", () => {
  test("persists the write set rank-ascending", async () => {
    await apply(mkWrites(["A", "C", "B"]));
    expect(await readOrder()).toEqual(["A", "C", "B"]);
  });

  test("a key absent from a later write SURVIVES (no delete)", async () => {
    // The headline change from the full-replace handler: the old one deleted A
    // and C here; the bounded upsert leaves them untouched.
    await apply(mkWrites(["A", "B", "C"]));
    // Re-rank only B, placing it before A (rank < A's). A and C keep their ranks.
    const aRank = Rank.nBetween(null, null, 3)[0]!;
    await apply([{ rowKey: "B", rank: Rank.between(null, aRank) }]);
    expect((await readOrder()).sort()).toEqual(["A", "B", "C"]);
    // B now sorts first (its new rank is below A's original min rank).
    expect((await readOrder())[0]).toBe("B");
  });

  test("an existing key's rank is updated in place", async () => {
    await apply(mkWrites(["A", "B", "C"]));
    const before = await t.db
      .select({
        rowKey: _dataViewRowOrder.rowKey,
        rank: _dataViewRowOrder.rank,
      })
      .from(_dataViewRowOrder);
    const rankOf = new Map(before.map((r) => [r.rowKey, r.rank]));

    // Move C to the very top: a fresh rank below A's.
    const newC = Rank.between(null, Rank.from(rankOf.get("A")!));
    await apply([{ rowKey: "C", rank: newC }]);

    const after = await t.db
      .select({
        rowKey: _dataViewRowOrder.rowKey,
        rank: _dataViewRowOrder.rank,
      })
      .from(_dataViewRowOrder);
    const nextRankOf = new Map(after.map((r) => [r.rowKey, r.rank]));

    expect(nextRankOf.get("C")).toBe(newC.toString());
    expect(nextRankOf.get("A")).toBe(rankOf.get("A")!); // unchanged
    expect(nextRankOf.get("B")).toBe(rankOf.get("B")!); // unchanged
    expect(await readOrder()).toEqual(["C", "A", "B"]);
  });

  test("ranks sort by C collation, matching Rank.compare", async () => {
    await apply(mkWrites(["A", "B", "C"]));
    const rows = await t.db
      .select({
        rowKey: _dataViewRowOrder.rowKey,
        rank: _dataViewRowOrder.rank,
      })
      .from(_dataViewRowOrder)
      .orderBy(asc(_dataViewRowOrder.rank));
    const inJs = [...rows]
      .sort((a, b) => Rank.compare(Rank.from(a.rank), Rank.from(b.rank)))
      .map((r) => r.rowKey);
    expect(rows.map((r) => r.rowKey)).toEqual(inJs);
  });

  test("rejects a duplicated rowKey (400), writing nothing", async () => {
    // Not `expect(...).rejects` — bun:test types that as non-thenable, which trips
    // `@typescript-eslint/await-thenable`. Catch the rejection explicitly instead.
    const ranks = Rank.nBetween(null, null, 3);
    let caught: unknown;
    await apply([
      { rowKey: "A", rank: ranks[0]! },
      { rowKey: "B", rank: ranks[1]! },
      { rowKey: "A", rank: ranks[2]! },
    ]).catch((err: unknown) => {
      caught = err;
    });
    expect(caught).toBeInstanceOf(HttpError);
    expect((caught as HttpError).status).toBe(400);
    // Rejected BEFORE any write.
    expect(await readOrder()).toEqual([]);
  });

  test("rejects a non-strictly-ascending rank sequence (400), writing nothing", async () => {
    const ranks = Rank.nBetween(null, null, 3);
    let caught: unknown;
    // Descending: ranks[2] then ranks[0].
    await apply([
      { rowKey: "A", rank: ranks[2]! },
      { rowKey: "B", rank: ranks[0]! },
    ]).catch((err: unknown) => {
      caught = err;
    });
    expect(caught).toBeInstanceOf(HttpError);
    expect((caught as HttpError).status).toBe(400);
    expect(await readOrder()).toEqual([]);
  });

  test("rejects an equal-rank pair (not strictly ascending)", async () => {
    const r = Rank.nBetween(null, null, 1)[0]!;
    let caught: unknown;
    await apply([
      { rowKey: "A", rank: r },
      { rowKey: "B", rank: r },
    ]).catch((err: unknown) => {
      caught = err;
    });
    expect(caught).toBeInstanceOf(HttpError);
    expect(await readOrder()).toEqual([]);
  });

  test("scopes the upsert to one view instance", async () => {
    await apply(mkWrites(["A", "B"]), "view-1");
    await apply(mkWrites(["B", "A"]), "view-2");
    // view-2's write must not touch view-1's rows.
    expect(await readOrder("view-1")).toEqual(["A", "B"]);
    expect(await readOrder("view-2")).toEqual(["B", "A"]);
  });
});
