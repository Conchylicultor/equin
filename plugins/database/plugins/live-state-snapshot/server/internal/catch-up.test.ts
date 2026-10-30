import {
  describe,
  test,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
} from "bun:test";
import { sql } from "drizzle-orm";
import {
  LIVE_STATE_CHANGELOG_HORIZON_TABLE,
  LIVE_STATE_CHANGELOG_TABLE,
  LIVE_STATE_SNAPSHOT_TABLE,
} from "@plugins/database/plugins/derived-views/core";
import { ensureChangelogTable } from "@plugins/database/plugins/change-feed/server/testing";
import type { FeedChange } from "@plugins/database/plugins/change-feed/server";
import type { ReplayScope } from "@plugins/framework/plugins/server-core/core";
import { ensureSnapshotTable } from "./tables-ddl";
import {
  createTestDb,
  type TestDb,
} from "@plugins/database/plugins/db-test-fixture/server/testing";
import { persistSnapshot } from "./persist";
import type { L2Expectation } from "./persist";
import { probeCatchUp, replayCatchUp } from "./catch-up";
import { pruneChangelog, readPruneHorizon } from "./changelog-horizon";

// Real-DB invariant suite for the cold-boot catch-up driver: the probe's
// xid-vs-floor arithmetic over USABLE rows only, the `xid >= floor` + `ORDER BY
// seq` replay predicate, the id-preserving replay (every op keeps `row.ids`, so
// a membership `D` stays scoped exactly as on the live path; only a genuinely
// null-ids row degrades to FULL), and the missing-history backstop verdict. A recording `route` spy is injected so we observe
// EXACTLY which changes replay (order, op, ids), without standing up the full
// server-core cascade. Runs the real SQL against a throwaway database on the running
// cluster (see the db-test-fixture primitive).

let t: TestDb;

beforeAll(async () => {
  t = await createTestDb({ prefix: "lss_test" });
  await ensureSnapshotTable(t.db);
  await ensureChangelogTable(t.db);
});

afterAll(async () => {
  await t.drop();
});

beforeEach(async () => {
  seeded.length = 0;
  await t.db.execute(sql.raw(`DELETE FROM ${LIVE_STATE_SNAPSHOT_TABLE}`));
  await t.db.execute(sql.raw(`DELETE FROM ${LIVE_STATE_CHANGELOG_TABLE}`));
  await t.db.execute(
    sql.raw(
      `UPDATE ${LIVE_STATE_CHANGELOG_HORIZON_TABLE} SET max_pruned_xid = NULL`,
    ),
  );
});

// The persisted keys the probe treats as usable (every `seedFloor` key).
const seeded: string[] = [];
const expectation = (): L2Expectation => ({
  persisted: [...seeded],
  definitions: {},
});

// Seed a usable snapshot row so `min(position)` yields the catch-up floor.
async function seedFloor(position: string, key = `floor-${position}`) {
  seeded.push(key);
  await persistSnapshot(t.db, key, "{}", {}, position, {
    mode: "replace",
    definition: null,
    guardTables: ["seed"],
  });
}

// The boot's catch-up: probe, then replay from the probe's floor.
async function runCatchUp(
  route: (c: FeedChange, replay?: ReplayScope) => void,
): Promise<void> {
  const probe = await probeCatchUp(t.db, expectation());
  if (probe.kind === "replay") {
    await replayCatchUp(t.db, probe.floor, probe.positions, route);
  }
}

interface ChangelogSeed {
  seq: number;
  xid: string;
  t: string;
  op: "I" | "U" | "D";
  ids: string[] | null;
  /** A routed table's row-wise layout, as `live_state_notify_routed()` writes it. */
  keys?: unknown;
  unchanged?: string[] | null;
  /** Written past the prune's 24 h ceiling (the prune deletes it whatever the floor). */
  aged?: boolean;
}

async function insertChangelog(row: ChangelogSeed): Promise<void> {
  const idsExpr =
    row.ids === null
      ? sql`NULL`
      : sql`ARRAY[${sql.join(
          row.ids.map((i) => sql`${i}`),
          sql`, `,
        )}]::text[]`;
  const unchangedExpr =
    row.unchanged === undefined || row.unchanged === null
      ? sql`NULL`
      : sql`ARRAY[${sql.join(
          row.unchanged.map((c) => sql`${c}`),
          sql`, `,
        )}]::text[]`;
  const keysExpr =
    row.keys === undefined
      ? sql`NULL`
      : sql`${JSON.stringify(row.keys)}::jsonb`;
  const atExpr = row.aged ? sql`now() - interval '25 hours'` : sql`now()`;
  await t.db.execute(sql`
    INSERT INTO ${sql.raw(LIVE_STATE_CHANGELOG_TABLE)} (seq, xid, t, op, ids, keys, unchanged, at)
    VALUES (${row.seq}, ${row.xid}::numeric, ${row.t}, ${row.op}, ${idsExpr}, ${keysExpr}, ${unchangedExpr}, ${atExpr})
  `);
}

function recorder(): {
  routed: FeedChange[];
  scopes: Array<ReplayScope | undefined>;
  route: (c: FeedChange, replay?: ReplayScope) => void;
} {
  const routed: FeedChange[] = [];
  const scopes: Array<ReplayScope | undefined> = [];
  return {
    routed,
    scopes,
    route: (c, replay) => {
      routed.push(c);
      scopes.push(replay);
    },
  };
}

describe("probeCatchUp + replayCatchUp", () => {
  test("no usable snapshot → `none`, zero replays even with changelog rows", async () => {
    await insertChangelog({ seq: 1, xid: "100", t: "ta", op: "U", ids: null });
    expect(await probeCatchUp(t.db, expectation())).toEqual({ kind: "none" });
    const { routed, route } = recorder();
    await runCatchUp(route);
    expect(routed).toEqual([]);
  });

  test("normal replay: only xid >= floor, in seq order, correct {table,op,ids}", async () => {
    await seedFloor("200");
    // Straddle the floor. min(xid)=100 < floor so NOT the backstop path.
    await insertChangelog({ seq: 1, xid: "100", t: "ta", op: "U", ids: ["1"] }); // excluded (< floor)
    await insertChangelog({ seq: 2, xid: "200", t: "tb", op: "I", ids: ["2"] }); // included (== floor)
    await insertChangelog({ seq: 3, xid: "300", t: "tc", op: "D", ids: ["3"] }); // included, DELETE → ids PRESERVED
    await insertChangelog({ seq: 4, xid: "400", t: "td", op: "U", ids: null }); // included, genuinely null-ids

    const { routed, route } = recorder();
    await runCatchUp(route);

    expect(routed).toEqual([
      {
        table: "tb",
        op: "I",
        ids: ["2"],
        source: "feed",
        keys: null,
        unchanged: null,
      },
      {
        table: "tc",
        op: "D",
        ids: ["3"],
        source: "feed",
        keys: null,
        unchanged: null,
      }, // DELETE ids preserved (replay ≡ live path; a membership entry stays scoped)
      {
        table: "td",
        op: "U",
        ids: null,
        source: "feed",
        keys: null,
        unchanged: null,
      }, // genuinely null-ids stays FULL
    ]);
  });

  test("boundary: xid == floor replayed, xid == floor-1 not", async () => {
    await seedFloor("200");
    await insertChangelog({
      seq: 1,
      xid: "199",
      t: "below",
      op: "U",
      ids: null,
    });
    await insertChangelog({ seq: 2, xid: "200", t: "at", op: "U", ids: null });

    const { routed, route } = recorder();
    await runCatchUp(route);

    expect(routed).toEqual([
      {
        table: "at",
        op: "U",
        ids: null,
        source: "feed",
        keys: null,
        unchanged: null,
      },
    ]);
  });

  test("backstop: the prune deleted a row at or after the floor → the backstop verdict, nothing replayed", async () => {
    await seedFloor("100");
    // The 24 h ceiling prunes the row at 150 — history at or after the floor
    // (100) is gone from under a stale snapshot. The caller clears the rows and
    // recomputes every persisted key — catch-up itself replays nothing (C20).
    await insertChangelog({
      seq: 1,
      xid: "150",
      t: "t1",
      op: "I",
      ids: ["a"],
      aged: true,
    });
    await insertChangelog({ seq: 2, xid: "200", t: "t1", op: "I", ids: ["a"] });
    await insertChangelog({ seq: 3, xid: "300", t: "t1", op: "U", ids: ["b"] });
    await pruneChangelog(t.db);

    expect(await probeCatchUp(t.db, expectation())).toEqual({
      kind: "backstop",
      floor: "100",
      horizon: "150",
    });
    const { routed, route } = recorder();
    await runCatchUp(route);
    expect(routed).toEqual([]);
  });

  test("an ordinary prune below the floor is no backstop, though the oldest survivor sits above the floor", async () => {
    // The changelog is sparse: no row has an xid exactly at the floor, so after
    // the prune removes everything below it the oldest retained row (105) is
    // above the floor (100) with nothing missing in between. The old rule
    // (oldest retained > floor) cleared and recomputed every persisted key on
    // every boot after a prune; the horizon (95) says nothing at or after the
    // floor was deleted.
    await seedFloor("100");
    await insertChangelog({ seq: 1, xid: "90", t: "ta", op: "U", ids: ["a"] });
    await insertChangelog({ seq: 2, xid: "95", t: "ta", op: "U", ids: ["b"] });
    await insertChangelog({ seq: 3, xid: "105", t: "ta", op: "U", ids: ["c"] });
    await pruneChangelog(t.db);
    expect(await readPruneHorizon(t.db)).toBe("95");

    expect(await probeCatchUp(t.db, expectation())).toEqual({
      kind: "replay",
      floor: "100",
      positions: new Map([["floor-100", "100"]]),
    });
    const { routed, route } = recorder();
    await runCatchUp(route);
    expect(routed.map((c) => c.ids)).toEqual([["c"]]);
  });

  test("every replayed row carries its xid and EVERY key's own floor, from the probe's one read", async () => {
    // Two keys at 100 and 300: the replay still reads from the oldest (100),
    // and hands the router each row's xid with both floors, so the router can
    // skip the key at 300 for the rows below it (see `ReplayScope`).
    await seedFloor("100", "low");
    await seedFloor("300", "high");
    await insertChangelog({ seq: 1, xid: "99", t: "ta", op: "U", ids: ["a"] });
    await insertChangelog({ seq: 2, xid: "100", t: "ta", op: "U", ids: ["b"] });
    await insertChangelog({ seq: 3, xid: "299", t: "ta", op: "U", ids: ["c"] });
    await insertChangelog({ seq: 4, xid: "300", t: "ta", op: "U", ids: ["d"] });
    const probe = await probeCatchUp(t.db, expectation());
    expect(probe).toEqual({
      kind: "replay",
      floor: "100",
      positions: new Map([
        ["low", "100"],
        ["high", "300"],
      ]),
    });
    const { routed, scopes, route } = recorder();
    await runCatchUp(route);
    expect(routed.map((c) => c.ids)).toEqual([["b"], ["c"], ["d"]]);
    expect(scopes.map((r) => r?.xid)).toEqual(["100", "299", "300"]);
    for (const scope of scopes) {
      expect(scope?.floors).toEqual(
        new Map([
          ["low", "100"],
          ["high", "300"],
        ]),
      );
    }
  });

  test("the floor is the oldest USABLE row's: an unusable row's position bounds nothing", async () => {
    await seedFloor("300");
    // A row for a key the runtime no longer persists, far older than the floor
    // — it would otherwise drag the floor (and the backstop) down.
    await persistSnapshot(t.db, "not-persisted", "{}", {}, "50", {
      mode: "replace",
      definition: null,
      guardTables: ["seed"],
    });
    await insertChangelog({ seq: 1, xid: "100", t: "ta", op: "U", ids: null });
    expect(await probeCatchUp(t.db, expectation())).toEqual({
      kind: "replay",
      floor: "300",
      positions: new Map([["floor-300", "300"]]),
    });
  });

  test("empty changelog since floor → already current, zero replays", async () => {
    await seedFloor("200");
    // All rows already incorporated (xid < floor). min(xid)=100 < floor so NOT
    // backstop; the `xid >= floor` select is empty → early 'already current'.
    await insertChangelog({ seq: 1, xid: "100", t: "ta", op: "U", ids: null });
    await insertChangelog({ seq: 2, xid: "150", t: "tb", op: "U", ids: null });

    const { routed, route } = recorder();
    await runCatchUp(route);

    expect(routed).toEqual([]);
  });

  test("a routed row replays its key layout (columnar) and its unchanged columns as written", async () => {
    await seedFloor("200");
    await insertChangelog({
      seq: 1,
      xid: "200",
      t: "side",
      op: "U",
      ids: ["s1"],
      keys: {
        c: ["host", "view"],
        r: [
          ["h1", "v"],
          ["h2", null],
        ],
      },
      unchanged: ["host"],
    });
    // A gated UPDATE whose every compared column moved. The routes may have
    // changed since (a catch-up always follows a restart), and that is fine:
    // `unchanged` names only columns KNOWN equal, whatever gate compared
    // them, so a route reading a column the old gate lacked is still reached.
    await insertChangelog({
      seq: 2,
      xid: "201",
      t: "hosts",
      op: "U",
      ids: ["a"],
      unchanged: [],
    });

    const { routed, route } = recorder();
    await runCatchUp(route);

    expect(routed).toEqual([
      {
        table: "side",
        op: "U",
        ids: ["s1"],
        source: "feed",
        keys: { host: ["h1", "h2"], view: ["v", null] },
        unchanged: ["host"],
      },
      {
        table: "hosts",
        op: "U",
        ids: ["a"],
        source: "feed",
        keys: null,
        unchanged: [],
      },
    ]);
  });

  test("a malformed layout replays the row unscoped — never dropped", async () => {
    await seedFloor("200");
    await insertChangelog({
      seq: 1,
      xid: "200",
      t: "side",
      op: "U",
      ids: ["s1"],
      keys: { c: ["host"], r: [["h1", "extra"]] },
      unchanged: ["host"],
    });

    const { routed, route } = recorder();
    await runCatchUp(route);

    expect(routed).toEqual([
      {
        table: "side",
        op: "U",
        ids: null,
        source: "feed",
        keys: null,
        unchanged: null,
      },
    ]);
  });
});

describe("the prune horizon", () => {
  test("the prune records the highest xid it deleted, and never lowers it", async () => {
    await seedFloor("100");
    await insertChangelog({ seq: 1, xid: "80", t: "ta", op: "U", ids: null });
    await pruneChangelog(t.db);
    expect(await readPruneHorizon(t.db)).toBe("80");
    // A prune deleting nothing, then one deleting a lower xid: unchanged.
    await pruneChangelog(t.db);
    expect(await readPruneHorizon(t.db)).toBe("80");
    await insertChangelog({ seq: 2, xid: "70", t: "ta", op: "U", ids: null });
    await pruneChangelog(t.db);
    expect(await readPruneHorizon(t.db)).toBe("80");
  });

  test("a missing row is seeded with the most that could have been pruned", async () => {
    const reseed = async () => {
      await t.db.execute(
        sql.raw(`DELETE FROM ${LIVE_STATE_CHANGELOG_HORIZON_TABLE}`),
      );
      await ensureSnapshotTable(t.db);
      return readPruneHorizon(t.db);
    };
    // Rows retained: everything below the oldest may have been pruned.
    await insertChangelog({ seq: 1, xid: "500", t: "ta", op: "U", ids: null });
    expect(await reseed()).toBe("499");
    // An empty changelog: everything so far may have been.
    await t.db.execute(sql.raw(`DELETE FROM ${LIVE_STATE_CHANGELOG_TABLE}`));
    const seeded = await reseed();
    expect(seeded).not.toBeNull();
    expect(BigInt(seeded!)).toBeGreaterThan(0n);
  });
});
