import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { sql } from "drizzle-orm";
import {
  LIVE_STATE_CHANGELOG_HORIZON_TABLE,
  LIVE_STATE_CHANGELOG_TABLE,
  LIVE_STATE_HANDOFF_TABLE,
} from "@plugins/database/plugins/derived-views/core";
import { ensureChangelogTable } from "@plugins/database/plugins/change-feed/server/testing";
import type {
  HandoffState,
  TableChange,
} from "@plugins/framework/plugins/server-core/core";
import {
  createTestDb,
  type TestDb,
} from "@plugins/database/plugins/db-test-fixture/server/testing";
import { ensureSnapshotTable } from "./tables-ddl";
import { loadEpochHandoff, writeEpochHandoff } from "./handoff";

// Real-DB suite for the epoch handoff's storage (`./handoff`): the old
// backend's write (cut, then state, then one row), the successor's load, and
// its replay of the changelog since the cut — with every arm that must make
// the successor load instead: no record, a cut that failed, history pruned at
// or past the cut, a rollup healed at boot.

let t: TestDb;

beforeAll(async () => {
  t = await createTestDb({ prefix: "lss_handoff" });
  await ensureSnapshotTable(t.db);
  await ensureChangelogTable(t.db);
});

afterAll(async () => {
  await t.drop();
});

beforeEach(async () => {
  await t.db.execute(sql.raw(`DELETE FROM ${LIVE_STATE_HANDOFF_TABLE}`));
  await t.db.execute(sql.raw(`DELETE FROM ${LIVE_STATE_CHANGELOG_TABLE}`));
  await t.db.execute(
    sql.raw(
      `UPDATE ${LIVE_STATE_CHANGELOG_HORIZON_TABLE} SET max_pruned_xid = NULL`,
    ),
  );
});

const STATE: HandoffState = {
  epoch: "epoch-old",
  tuples: [
    {
      key: "pt:rows",
      pk: '{"ids":"a"}',
      params: { ids: "a" },
      version: 3,
      definition: "def-1",
    },
  ],
};

const deps = {
  changelogTables: () => ["items"],
  healedRollups: () => [] as readonly string[],
  schemaChanged: () => false,
  listening: () => Promise.resolve(),
};

async function write(cutXid = "1000"): Promise<unknown[]> {
  const reported: unknown[] = [];
  await writeEpochHandoff(t.db, {
    cut: async () => ({ cutXid }),
    state: () => STATE,
    report: (err) => reported.push(err),
  });
  return reported;
}

async function changelog(seq: number, xid: string, ids: string[]) {
  await t.db.execute(sql`
    INSERT INTO ${sql.raw(LIVE_STATE_CHANGELOG_TABLE)} (seq, xid, t, op, ids)
    VALUES (${seq}, ${xid}::numeric, 'items', 'U',
            ARRAY[${sql.join(
              ids.map((i) => sql`${i}`),
              sql`, `,
            )}]::text[])
  `);
}

function recorder() {
  const routed: TableChange[] = [];
  return { routed, route: (c: TableChange) => routed.push(c) };
}

describe("the epoch handoff's storage", () => {
  test("a written record loads back: its tuples and the changelog tables", async () => {
    expect(await write()).toEqual([]);
    const record = await loadEpochHandoff(t.db, "epoch-old", deps);
    expect(record).not.toBeNull();
    expect(record!.tuples).toEqual(STATE.tuples);
    expect([...record!.changelogTables]).toEqual(["items"]);
  });

  test("no record for the epoch: null", async () => {
    await write();
    expect(await loadEpochHandoff(t.db, "epoch-other", deps)).toBeNull();
  });

  test("a cut that fails writes nothing and is reported", async () => {
    const reported: unknown[] = [];
    let stateTaken = false;
    await writeEpochHandoff(t.db, {
      cut: async () => {
        throw new Error("feed cut failed: no LISTEN session is established");
      },
      state: () => {
        stateTaken = true;
        return STATE;
      },
      report: (err) => reported.push(err),
    });
    expect(reported).toHaveLength(1);
    expect(stateTaken).toBe(false);
    expect(await loadEpochHandoff(t.db, "epoch-old", deps)).toBeNull();
  });

  test("the replay routes exactly the changelog rows at or after the cut, in order", async () => {
    await write("1000");
    await changelog(1, "999", ["old"]);
    await changelog(2, "1000", ["a"]);
    await changelog(3, "1005", ["b"]);
    const record = await loadEpochHandoff(t.db, "epoch-old", deps);
    const r = recorder();
    expect(await record!.replay(r.route)).toEqual({ ok: true });
    expect(r.routed.map((c) => c.ids)).toEqual([["a"], ["b"]]);
  });

  test("history pruned at or past the cut: the replay refuses, routing nothing", async () => {
    await write("1000");
    await changelog(1, "1005", ["b"]);
    await t.db.execute(
      sql.raw(
        `UPDATE ${LIVE_STATE_CHANGELOG_HORIZON_TABLE} SET max_pruned_xid = 1000`,
      ),
    );
    const record = await loadEpochHandoff(t.db, "epoch-old", deps);
    const r = recorder();
    expect(await record!.replay(r.route)).toEqual({
      ok: false,
      reason: "pruned",
    });
    expect(r.routed).toEqual([]);
  });

  test("a prune below the cut is no refusal", async () => {
    await write("1000");
    await t.db.execute(
      sql.raw(
        `UPDATE ${LIVE_STATE_CHANGELOG_HORIZON_TABLE} SET max_pruned_xid = 999`,
      ),
    );
    const record = await loadEpochHandoff(t.db, "epoch-old", deps);
    expect(await record!.replay(recorder().route)).toEqual({ ok: true });
  });

  test("a rollup healed at boot: the replay refuses", async () => {
    await write();
    const record = await loadEpochHandoff(t.db, "epoch-old", {
      ...deps,
      healedRollups: () => ["attempt_conv_agg"],
    });
    expect(await record!.replay(recorder().route)).toEqual({
      ok: false,
      reason: "healed-rollup",
    });
  });

  test("a record older than its freshness window: null", async () => {
    await write();
    await t.db.execute(
      sql.raw(
        `UPDATE ${LIVE_STATE_HANDOFF_TABLE} SET written_at = now() - interval '2 minutes'`,
      ),
    );
    expect(await loadEpochHandoff(t.db, "epoch-old", deps)).toBeNull();
  });

  test("a write drops every other boot's record: only the latest is trusted", async () => {
    await write();
    await writeEpochHandoff(t.db, {
      cut: async () => ({ cutXid: "1000" }),
      state: () => ({ ...STATE, epoch: "epoch-newer" }),
      report: (err) => {
        throw err;
      },
    });
    expect(await loadEpochHandoff(t.db, "epoch-old", deps)).toBeNull();
    expect(await loadEpochHandoff(t.db, "epoch-newer", deps)).not.toBeNull();
  });

  test("a migration applied at boot: the replay refuses", async () => {
    await write();
    const record = await loadEpochHandoff(t.db, "epoch-old", {
      ...deps,
      schemaChanged: () => true,
    });
    expect(await record!.replay(recorder().route)).toEqual({
      ok: false,
      reason: "migrated",
    });
  });

  test("the replay reads the changelog only once the LISTEN session is up", async () => {
    await write("1000");
    await changelog(1, "1001", ["a"]);
    let up!: () => void;
    const listening = new Promise<void>((r) => (up = r));
    const record = await loadEpochHandoff(t.db, "epoch-old", {
      ...deps,
      listening: () => listening,
    });
    const r = recorder();
    const replayed = record!.replay(r.route);
    await new Promise((res) => setTimeout(res, 20));
    expect(r.routed).toEqual([]);
    up();
    expect(await replayed).toEqual({ ok: true });
    expect(r.routed.map((c) => c.ids)).toEqual([["a"]]);
  });

  test("a second write under the same epoch replaces the record", async () => {
    await write("1000");
    await write("2000");
    await changelog(1, "1500", ["a"]);
    const record = await loadEpochHandoff(t.db, "epoch-old", deps);
    const r = recorder();
    await record!.replay(r.route);
    // The cut moved to 2000: the row at 1500 is below it.
    expect(r.routed).toEqual([]);
  });
});
