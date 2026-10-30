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
import type {
  PersistedValueCheck,
  ReplayScope,
  SeedOutcome,
} from "@plugins/framework/plugins/server-core/core";
import {
  createTestDb,
  type TestDb,
} from "@plugins/database/plugins/db-test-fixture/server/testing";
import { ensureSnapshotTable } from "./tables-ddl";
import { pruneChangelog } from "./changelog-horizon";
import { persistSnapshot, readPersistedSnapshots } from "./persist";
import type { L2Expectation } from "./persist";
import {
  clearHealedSnapshots,
  clearInvalidAliasSnapshots,
  runBootCatchUp,
} from "./boot-catch-up";

// The L2 boot sequence (`onReady`) against a throwaway database, with the
// runtime calls recorded: the backstop clears the rows and recomputes EVERY
// persisted key (seeding nothing, replaying nothing); otherwise each key with
// no usable row recomputes, each alias seeds from its usable row with the row's
// position as its base floor, and the changelog replays from the probe's floor.

let t: TestDb;

beforeAll(async () => {
  t = await createTestDb({ prefix: "lss_boot" });
  await ensureSnapshotTable(t.db);
  await ensureChangelogTable(t.db);
});

afterAll(async () => {
  await t.drop();
});

beforeEach(async () => {
  await t.db.execute(sql.raw(`DELETE FROM ${LIVE_STATE_SNAPSHOT_TABLE}`));
  await t.db.execute(sql.raw(`DELETE FROM ${LIVE_STATE_CHANGELOG_TABLE}`));
  await t.db.execute(
    sql.raw(
      `UPDATE ${LIVE_STATE_CHANGELOG_HORIZON_TABLE} SET max_pruned_xid = NULL`,
    ),
  );
});

async function row(
  key: string,
  position: string,
  definition: string | null = null,
  value: unknown = [{ id: key }],
): Promise<void> {
  await persistSnapshot(t.db, key, "{}", value, position, {
    mode: "replace",
    definition,
    guardTables: ["t"],
  });
}

async function changelog(seq: number, xid: string): Promise<void> {
  await t.db.execute(sql`
    INSERT INTO ${sql.raw(LIVE_STATE_CHANGELOG_TABLE)} (seq, xid, t, op, ids)
    VALUES (${seq}, ${xid}::numeric, 't', 'U', ARRAY['x']::text[])
  `);
}

// The real prune, deleting a row at `xid` past its 24 h ceiling (and, as it
// always does, every row below the global snapshot floor): the horizon moves to
// the highest xid it deleted.
async function prunedThrough(seq: number, xid: string): Promise<void> {
  await t.db.execute(sql`
    INSERT INTO ${sql.raw(LIVE_STATE_CHANGELOG_TABLE)} (seq, xid, t, op, ids, at)
    VALUES (${seq}, ${xid}::numeric, 't', 'U', ARRAY['x']::text[], now() - interval '25 hours')
  `);
  await pruneChangelog(t.db);
}

function recorder(aliasKeys: string[], invalid: readonly string[] = []) {
  const recomputed: string[] = [];
  const seeded: Array<{ key: string; value: unknown; position: string }> = [];
  const routed: FeedChange[] = [];
  // The per-key floors each replayed row was routed with (one map per run).
  const floors: Array<ReadonlyMap<string, string> | undefined> = [];
  return {
    recomputed,
    seeded,
    routed,
    floors,
    rt: {
      aliasKeys,
      recompute: (k: string) => recomputed.push(k),
      // The runtime's A30 parse, stood in for: a key listed `invalid` holds a
      // value its payload schema rejects.
      seed: (
        key: string,
        value: unknown,
        base: { position: string },
      ): SeedOutcome => {
        if (invalid.includes(key)) {
          return { kind: "invalid", error: "Expected array, received object" };
        }
        seeded.push({ key, value, position: base.position });
        return { kind: "seeded" };
      },
      route: (c: FeedChange, replay?: ReplayScope) => {
        routed.push(c);
        floors.push(replay?.floors);
      },
      healedRollups: [] as readonly string[],
    },
  };
}

const exp = (
  persisted: string[],
  definitions: Record<string, string> = {},
): L2Expectation => ({ persisted, definitions });

// A hot swap's other writer: once `arm()` is called (from a runtime callback
// the boot makes AFTER its probe), the next statement the boot issues is
// preceded by that writer's floor persist LOWERING `key`'s row to `lowerTo`
// — the row the boot then seeds from (or re-reads) sits below the probe's floor.
function lowerAfterProbe(lowerTo: string, key = "alias") {
  let armed = false;
  let done = false;
  const db = new Proxy(t.db, {
    get(target, prop) {
      if (prop !== "execute") return Reflect.get(target, prop, target);
      return async (...args: Parameters<typeof target.execute>) => {
        if (armed && !done) {
          done = true;
          await persistSnapshot(t.db, key, "{}", [{ id: "a1" }], lowerTo, {
            mode: "floor",
            definition: null,
            guardTables: ["t"],
          });
        }
        return target.execute(...args);
      };
    },
  });
  return {
    db,
    arm: () => {
      armed = true;
    },
  };
}

describe("runBootCatchUp", () => {
  test("a backstop boot clears the rows and recomputes EVERY persisted key — nothing seeded or replayed", async () => {
    await row("alias", "100");
    await row("legacy", "150");
    await prunedThrough(1, "120"); // a row at or after the floor 100 was pruned
    await changelog(2, "200");
    const r = recorder(["alias"]);
    const verdict = await runBootCatchUp(
      t.db,
      exp(["alias", "legacy", "never-written"]),
      r.rt,
    );
    expect(verdict).toBe("backstop");
    expect(r.recomputed.sort()).toEqual(["alias", "legacy", "never-written"]);
    expect(r.seeded).toEqual([]);
    expect(r.routed).toEqual([]);
    const left = await t.db.execute<{ n: number }>(
      sql.raw(`SELECT count(*)::int AS n FROM ${LIVE_STATE_SNAPSHOT_TABLE}`),
    );
    expect(left.rows[0]!.n).toBe(0);
  });

  test("a rollup healed by the boot reconcile clears the rows and recomputes EVERY persisted key", async () => {
    await row("alias", "100", "def-a", [{ id: "a1" }]);
    await changelog(1, "120"); // a replayable history: still not trusted
    const r = recorder(["alias"]);
    const verdict = await runBootCatchUp(
      t.db,
      exp(["alias", "other"], { alias: "def-a" }),
      {
        ...r.rt,
        healedRollups: ["attempt_conv_agg"],
      },
    );
    expect(verdict).toBe("backstop");
    expect(r.recomputed.sort()).toEqual(["alias", "other"]);
    expect(r.seeded).toEqual([]);
    expect(r.routed).toEqual([]);
    const left = await t.db.execute<{ n: number }>(
      sql.raw(`SELECT count(*)::int AS n FROM ${LIVE_STATE_SNAPSHOT_TABLE}`),
    );
    expect(left.rows[0]!.n).toBe(0);
  });

  test("a normal boot recomputes the unusable keys, seeds each usable alias at its row's position, then replays", async () => {
    await row("alias", "100", "def-a", [{ id: "a1" }]);
    await row("stale-def", "100", "old");
    await changelog(1, "90"); // below the floor: not replayed
    await changelog(2, "120"); // replayed
    const r = recorder(["alias", "stale-def"]);
    const verdict = await runBootCatchUp(
      t.db,
      exp(["alias", "stale-def", "missing"], {
        alias: "def-a",
        "stale-def": "new",
      }),
      r.rt,
    );
    expect(verdict).toBe("replay");
    expect(r.recomputed.sort()).toEqual(["missing", "stale-def"]);
    expect(r.seeded).toEqual([
      { key: "alias", value: [{ id: "a1" }], position: "100" },
    ]);
    expect(r.routed.map((c) => c.ids)).toEqual([["x"]]);
    // Only the seeded alias has a floor: the recomputed keys get every row.
    expect(r.floors).toEqual([new Map([["alias", "100"]])]);
  });

  test("each key's replay floor is its own row's position, and a key recomputed at boot has none", async () => {
    await row("low", "100", null, [{ id: "a1" }]);
    await row("high", "300", null, [{ id: "b1" }]);
    await row("stale-def", "50", "old");
    await changelog(1, "40"); // oldest retained, below every floor
    await changelog(2, "200");
    await changelog(3, "300");
    const r = recorder(["low", "high"]);
    const verdict = await runBootCatchUp(
      t.db,
      exp(["low", "high", "stale-def"], { "stale-def": "new" }),
      r.rt,
    );
    expect(verdict).toBe("replay");
    expect(r.recomputed).toEqual(["stale-def"]);
    expect(r.routed).toHaveLength(2);
    expect(r.floors[0]).toEqual(
      new Map([
        ["low", "100"],
        ["high", "300"],
      ]),
    );
  });

  test("A30: an alias whose value does not parse as its payload is treated as missing — row cleared, key recomputed, never seeded", async () => {
    await row("alias", "100", null, [{ id: "a1" }]);
    await row("bad", "100", null, { not: "an array" });
    await changelog(1, "90"); // the oldest retained: below the floor
    await changelog(2, "120");
    const r = recorder(["alias", "bad"], ["bad"]);
    const verdict = await runBootCatchUp(t.db, exp(["alias", "bad"]), r.rt);
    expect(verdict).toBe("replay");
    expect(r.recomputed).toEqual(["bad"]);
    expect(r.seeded.map((s) => s.key)).toEqual(["alias"]);
    // Cleared: boot-snapshot serves it no more; the other alias's row stays.
    const left = await readPersistedSnapshots(t.db, ["alias", "bad"], {
      persisted: ["alias", "bad"],
      definitions: {},
    });
    expect([...left.keys()]).toEqual(["alias"]);
    expect(r.routed.map((c) => c.ids)).toEqual([["x"]]);
  });

  test("a seeded row lowered after the probe (hot swap) lowers the replay floor with it", async () => {
    await row("alias", "100", null, [{ id: "a1" }]);
    await changelog(1, "40"); // oldest retained
    await changelog(2, "70"); // below the probe's floor, above the lowered row's
    await changelog(3, "120");
    const other = lowerAfterProbe("50");
    const r = recorder(["alias"]);
    // "trigger" has no row: its recompute runs after the probe and before the
    // seed read — the window the other writer lands in.
    const rt = {
      ...r.rt,
      recompute: (k: string) => {
        other.arm();
        r.rt.recompute(k);
      },
    };
    const verdict = await runBootCatchUp(
      other.db as typeof t.db,
      exp(["alias", "trigger"]),
      rt,
    );
    expect(verdict).toBe("replay");
    expect(r.seeded).toEqual([
      { key: "alias", value: [{ id: "a1" }], position: "50" },
    ]);
    // Replayed from 50, not the probe's 100: the commit at 70 reaches the alias.
    expect(r.routed).toHaveLength(2);
    // …and the alias's own floor is lowered with it, so the router does not
    // skip it for that commit.
    expect(r.floors[0]).toEqual(new Map([["alias", "50"]]));
  });

  test("a non-alias row lowered after the probe (hot swap) lowers that key's replay floor too", async () => {
    await row("plain", "100");
    await changelog(1, "40"); // oldest retained
    await changelog(2, "70"); // below the probe's 100, above the lowered 50
    await changelog(3, "120");
    const other = lowerAfterProbe("50", "plain");
    const r = recorder([]); // no alias: nothing seeded
    const rt = {
      ...r.rt,
      recompute: (k: string) => {
        other.arm();
        r.rt.recompute(k);
      },
    };
    const verdict = await runBootCatchUp(
      other.db as typeof t.db,
      exp(["plain", "trigger"]),
      rt,
    );
    expect(verdict).toBe("replay");
    // The re-read before the replay lowers `plain`'s floor to 50 — and the
    // replay's read floor with it, so the commit at 70 reaches the key.
    expect(r.routed).toHaveLength(2);
    expect(r.floors[0]).toEqual(new Map([["plain", "50"]]));
  });

  test("a seeded row lowered past the prune horizon is recomputed, never seeded", async () => {
    await row("alias", "100", null, [{ id: "a1" }]);
    await changelog(1, "40");
    // The prune deletes 35 (past its ceiling) and 40 (below the floor 100): the
    // horizon is 40 — under the probe's floor, over the lowered position.
    await prunedThrough(2, "35");
    await changelog(3, "120");
    const other = lowerAfterProbe("30");
    const r = recorder(["alias"]);
    const rt = {
      ...r.rt,
      recompute: (k: string) => {
        other.arm();
        r.rt.recompute(k);
      },
    };
    await runBootCatchUp(
      other.db as typeof t.db,
      exp(["alias", "trigger"]),
      rt,
    );
    expect(r.seeded).toEqual([]);
    expect(r.recomputed.sort()).toEqual(["alias", "trigger"]);
    expect(r.routed).toHaveLength(1); // the probe's floor (100) still replays
  });

  test("no usable row: every persisted key recomputes, nothing replays", async () => {
    await changelog(1, "10");
    const r = recorder([]);
    expect(await runBootCatchUp(t.db, exp(["a", "b"]), r.rt)).toBe("none");
    expect(r.recomputed.sort()).toEqual(["a", "b"]);
    expect(r.routed).toEqual([]);
  });
});

describe("clearHealedSnapshots (onReadyBlocking)", () => {
  // Runs before readiness flips: boot-snapshot's first read
  // (`readPersistedSnapshots`, the predicate read) must find no value computed
  // from a rollup the boot reconcile had to heal.
  test("a healed boot serves no L2 row from boot-snapshot", async () => {
    await row("alias", "100", "def-a", [{ id: "a1" }]);
    await row("other", "100", null, [{ id: "o1" }]);
    const e = exp(["alias", "other"], { alias: "def-a" });
    expect(
      (await readPersistedSnapshots(t.db, ["alias", "other"], e)).size,
    ).toBe(2);
    expect(await clearHealedSnapshots(t.db, e, ["attempt_conv_agg"])).toBe(2);
    expect(
      (await readPersistedSnapshots(t.db, ["alias", "other"], e)).size,
    ).toBe(0);
  });

  test("a clean boot clears nothing", async () => {
    await row("alias", "100", "def-a", [{ id: "a1" }]);
    const e = exp(["alias"], { alias: "def-a" });
    expect(await clearHealedSnapshots(t.db, e, [])).toBe(0);
    expect((await readPersistedSnapshots(t.db, ["alias"], e)).size).toBe(1);
  });
});

describe("clearInvalidAliasSnapshots (onReadyBlocking, A30)", () => {
  // Runs before readiness flips: boot-snapshot's persisted fast path is open
  // from readiness, before onReady's seed puts a kept snapshot in front of the
  // row — so a value the payload schema rejects must already be gone.
  const arrayPayload = (key: string, value: unknown): PersistedValueCheck =>
    key === "not-alias"
      ? { kind: "skipped" }
      : Array.isArray(value)
        ? { kind: "valid" }
        : { kind: "invalid", error: "Expected array, received object" };

  test("clears only the persisted alias rows whose value does not parse; the rest stay served", async () => {
    await row("alias", "100", null, [{ id: "a1" }]);
    await row("bad", "100", null, { not: "an array" });
    // Not an alias: never validated (the runtime answers skipped).
    await row("not-alias", "100", null, { any: "shape" });
    // An alias the runtime no longer persists: the usable predicate hides it.
    await row("unpersisted", "100", null, { not: "an array" });
    const e = exp(["alias", "bad", "not-alias"]);
    const validated: string[] = [];
    const cleared = await clearInvalidAliasSnapshots(t.db, e, {
      aliasKeys: ["alias", "bad", "unpersisted"],
      validate: (k, v) => {
        validated.push(k);
        return arrayPayload(k, v);
      },
    });
    expect(cleared).toEqual([
      { key: "bad", error: "Expected array, received object" },
    ]);
    expect(validated.sort()).toEqual(["alias", "bad"]);
    const left = await readPersistedSnapshots(
      t.db,
      ["alias", "bad", "not-alias"],
      e,
    );
    expect([...left.keys()].sort()).toEqual(["alias", "not-alias"]);
  });

  test("then onReady finds no row for the cleared alias and recomputes it — the seed never sees it", async () => {
    await row("alias", "100", null, [{ id: "a1" }]);
    await row("bad", "100", null, { not: "an array" });
    await changelog(1, "90");
    await changelog(2, "120");
    const e = exp(["alias", "bad"]);
    await clearInvalidAliasSnapshots(t.db, e, {
      aliasKeys: ["alias", "bad"],
      validate: arrayPayload,
    });
    const r = recorder(["alias", "bad"]);
    expect(await runBootCatchUp(t.db, e, r.rt)).toBe("replay");
    expect(r.recomputed).toEqual(["bad"]);
    expect(r.seeded.map((x) => x.key)).toEqual(["alias"]);
  });

  test("a clean boot clears nothing", async () => {
    await row("alias", "100", null, [{ id: "a1" }]);
    const e = exp(["alias"]);
    expect(
      await clearInvalidAliasSnapshots(t.db, e, {
        aliasKeys: ["alias"],
        validate: arrayPayload,
      }),
    ).toEqual([]);
    expect((await readPersistedSnapshots(t.db, ["alias"], e)).size).toBe(1);
  });
});
