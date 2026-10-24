import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { Client } from "pg";
import {
  createTestDb,
  type TestDb,
} from "@plugins/database/plugins/db-test-fixture/server/testing";
import type { TableLayoutRequirement } from "@plugins/framework/plugins/server-core/core";
import {
  parseKeyLayout,
  parseLiveStatePayload,
  type DbChange,
} from "./parse-payload";
import {
  compileTableTriggerDdl,
  rebuildTriggers,
  resolveLayout,
} from "./triggers";
import {
  findLayoutViolations,
  installedLayouts,
  readInstalledTriggers,
} from "./route-layout";

// The routed trigger layout (P3 of research/2026-09-29-global-scoped-change-routing.md)
// on a throwaway database: what `live_state_notify_routed()` puts on the wire
// and in the changelog for a table a route reads, and that every OTHER table's
// trigger — DDL and payload — is exactly the PK-only feed's.
//
// The witness is the raw NOTIFY stream (a dedicated LISTEN client, parsed by the
// production `parseLiveStatePayload`) and the changelog rows beside it.
//
// Requires a running Postgres cluster (started by ./equin build).

let testDb: TestDb;
let listen: Client;
const raw: string[] = [];

const NO_EXCLUSIONS = {
  feedExempt: new Set<string>(),
  optedOut: new Set<string>(),
  produced: new Set<string>(),
};

// The routed tables and what their routes would require:
// - rt_hosts: an identity route on the PK reading every column but `secret`,
//   beside a route reading the whole table: gated on the narrow route's
//   columns only (`secret` is read by the whole-table route alone, so it is
//   never compared);
// - rt_side: an alias route carrying its host key `host`, reading every column
//   (no gate: no route could be skipped);
// - rt_values: a composite-keyed side table (`row_key` + `view_id` + `col`),
//   carried, never gated (no single-column PK to pair old and new rows by).
const LAYOUTS: TableLayoutRequirement[] = [
  {
    table: "rt_hosts",
    carry: [],
    reads: [
      ["id", "n", "secret", "title"],
      ["id", "n", "title"],
    ],
  },
  { table: "rt_side", carry: ["host"], reads: [["host", "id", "score"]] },
  {
    table: "rt_values",
    carry: ["col", "row_key", "view_id"],
    reads: [["col", "row_key", "value", "view_id"]],
  },
];

async function drain(): Promise<DbChange[]> {
  // A NOTIFY is delivered at commit; one round trip on the listening socket
  // flushes everything already sent.
  await listen.query("SELECT 1");
  const out = raw.splice(0).map((p) => {
    const change = parseLiveStatePayload(p);
    if (change === null) throw new Error(`unparseable payload ${p}`);
    return change;
  });
  return out;
}

const sorted = (xs: readonly (string | null)[] | null | undefined) =>
  xs == null ? xs : [...xs].sort();

/** A layout's rows as sorted tuples, whatever order DISTINCT produced them in. */
function rowsOf(
  keys: DbChange["keys"],
  columns: readonly string[],
): (string | null)[][] | null {
  if (keys === null) return null;
  const n = keys[columns[0]!]!.length;
  const rows: (string | null)[][] = [];
  for (let i = 0; i < n; i++) rows.push(columns.map((c) => keys[c]![i]!));
  return rows.sort((a, b) =>
    JSON.stringify(a).localeCompare(JSON.stringify(b)),
  );
}

beforeAll(async () => {
  testDb = await createTestDb({ prefix: "cf_routed_test" });
  await testDb.db.execute(
    sql.raw(`
      CREATE TABLE rt_hosts (id text PRIMARY KEY, title text, n integer, secret text);
      CREATE TABLE rt_side (id text PRIMARY KEY, host text, score integer);
      CREATE TABLE rt_values (view_id text, row_key text, col text, value text,
                              PRIMARY KEY (view_id, row_key, col));
      CREATE TABLE rt_plain (id text PRIMARY KEY, v text);
    `),
  );
  await rebuildTriggers(testDb.db, NO_EXCLUSIONS, LAYOUTS);
  listen = new Client({ connectionString: testDb.connectionString });
  await listen.connect();
  listen.on("notification", (n) => {
    if (n.channel === "live_state" && n.payload) raw.push(n.payload);
  });
  await listen.query("LISTEN live_state");
});

afterAll(async () => {
  await listen?.end();
  await testDb?.drop();
});

describe("an unrouted table keeps the PK-only feed", () => {
  test("its trigger DDL is byte-identical to the PK-only feed's", () => {
    expect(compileTableTriggerDdl("rt_plain", "id")).toEqual([
      `DROP TRIGGER IF EXISTS "live_state_rt_plain_i" ON "rt_plain"`,
      `DROP TRIGGER IF EXISTS "live_state_rt_plain_u" ON "rt_plain"`,
      `DROP TRIGGER IF EXISTS "live_state_rt_plain_d" ON "rt_plain"`,
      `CREATE TRIGGER "live_state_rt_plain_i" AFTER INSERT ON "rt_plain"
           REFERENCING NEW TABLE AS new_rows
           FOR EACH STATEMENT EXECUTE FUNCTION live_state_notify('id')`,
      `CREATE TRIGGER "live_state_rt_plain_u" AFTER UPDATE ON "rt_plain"
           REFERENCING NEW TABLE AS new_rows
           FOR EACH STATEMENT EXECUTE FUNCTION live_state_notify('id')`,
      `CREATE TRIGGER "live_state_rt_plain_d" AFTER DELETE ON "rt_plain"
           REFERENCING OLD TABLE AS old_rows
           FOR EACH STATEMENT EXECUTE FUNCTION live_state_notify('id')`,
    ]);
  });

  test("its payload carries exactly {t, op, ids, x, at} and its changelog row no layout", async () => {
    await drain();
    await testDb.db.execute(sql`INSERT INTO rt_plain VALUES ('p1', 'a')`);
    await testDb.db.execute(sql`UPDATE rt_plain SET id = 'p2' WHERE id = 'p1'`);
    await listen.query("SELECT 1");
    const payloads = raw.splice(0).map((p) => JSON.parse(p) as object);
    expect(payloads.map((p) => Object.keys(p).sort())).toEqual([
      ["at", "ids", "op", "t", "x"],
      ["at", "ids", "op", "t", "x"],
    ]);
    // The PK-only UPDATE reads new_rows only: the old id is not sent.
    expect((payloads[1] as { ids: string[] }).ids).toEqual(["p2"]);
    const log = await testDb.db.execute<{ keys: unknown; unchanged: unknown }>(
      sql`SELECT keys, unchanged FROM live_state_changelog WHERE t = 'rt_plain' ORDER BY seq`,
    );
    expect(log.rows).toEqual([
      { keys: null, unchanged: null },
      { keys: null, unchanged: null },
    ]);
  });
});

describe("a routed table's layout", () => {
  test("INSERT: ids and the carried keys of the new rows", async () => {
    await drain();
    await testDb.db.execute(
      sql`INSERT INTO rt_side VALUES ('s1', 'h1', 1), ('s2', 'h2', 2), ('s3', 'h1', 3)`,
    );
    const [c] = await drain();
    expect(c!.op).toBe("I");
    expect(sorted(c!.ids)).toEqual(["s1", "s2", "s3"]);
    // DISTINCT over the carried columns: h1 once.
    expect(rowsOf(c!.keys, ["host"])).toEqual([["h1"], ["h2"]]);
    expect(c!.unchanged).toBeNull();
  });

  test("UPDATE moving a host key names both the old and the new host", async () => {
    await drain();
    await testDb.db.execute(
      sql`UPDATE rt_side SET host = 'h9' WHERE id = 's2'`,
    );
    const [c] = await drain();
    expect(c!.ids).toEqual(["s2"]);
    expect(rowsOf(c!.keys, ["host"])).toEqual([["h2"], ["h9"]]);
    // rt_side is not gated (its routes read every column): nothing known.
    expect(c!.unchanged).toBeNull();
  });

  test("DELETE: the keys come from the old rows", async () => {
    await drain();
    await testDb.db.execute(sql`DELETE FROM rt_side WHERE id = 's3'`);
    const [c] = await drain();
    expect(c!.op).toBe("D");
    expect(c!.ids).toEqual(["s3"]);
    expect(rowsOf(c!.keys, ["host"])).toEqual([["h1"]]);
  });

  test("gated UPDATE: `unchanged` names exactly the gate columns equal in every row", async () => {
    await testDb.db.execute(
      sql`INSERT INTO rt_hosts VALUES ('a', 'A', 1, 's'), ('b', 'B', 2, 's')`,
    );
    await drain();
    await testDb.db.execute(sql`UPDATE rt_hosts SET n = n + 1, secret = 'x'`);
    const [c] = await drain();
    expect(sorted(c!.ids)).toEqual(["a", "b"]);
    // `n` moved. `secret` is not compared (only the whole-table route reads
    // it): an uncompared column is never listed, whether it moved or not.
    expect(c!.unchanged).toEqual(["id", "title"]);
    // No carried column: no layout.
    expect(c!.keys).toBeNull();
  });

  test("gated UPDATE touching no gate column: every compared column is listed, the uncompared one is not", async () => {
    await drain();
    await testDb.db.execute(
      sql`UPDATE rt_hosts SET secret = 'y' WHERE id = 'a'`,
    );
    const [c] = await drain();
    // The narrow route (id, n, title) can skip it; the whole-table route,
    // reading `secret`, cannot.
    expect(c!.unchanged).toEqual(["id", "n", "title"]);
  });

  test("a key-changing UPDATE sends old ∪ new ids and an unknown `unchanged`", async () => {
    await drain();
    await testDb.db.execute(
      sql`UPDATE rt_hosts SET id = 'a2', title = 'A2' WHERE id = 'a'`,
    );
    const [c] = await drain();
    expect(sorted(c!.ids)).toEqual(["a", "a2"]);
    // The PK moved, so old and new rows cannot be paired: nothing known.
    expect(c!.unchanged).toBeNull();
  });

  test("a composite-keyed table: no ids, its key columns carried", async () => {
    await drain();
    await testDb.db.execute(
      sql`INSERT INTO rt_values VALUES ('v', 'r1', 'c1', 'x'), ('v', 'r2', 'c1', 'y'), ('w', 'r1', 'c2', 'z')`,
    );
    await testDb.db.execute(
      sql`UPDATE rt_values SET value = 'x2' WHERE row_key = 'r1'`,
    );
    const [ins, upd] = await drain();
    expect(ins!.ids).toBeNull();
    expect(rowsOf(ins!.keys, ["col", "row_key", "view_id"])).toEqual([
      ["c1", "r1", "v"],
      ["c1", "r2", "v"],
      ["c2", "r1", "w"],
    ]);
    // Old ∪ new, DISTINCT: an update that rewrote only `value` keeps its keys once.
    expect(rowsOf(upd!.keys, ["col", "row_key", "view_id"])).toEqual([
      ["c1", "r1", "v"],
      ["c2", "r1", "w"],
    ]);
    // No single-column PK to pair old and new rows by: never gated.
    expect(upd!.unchanged).toBeNull();
  });

  test("over the NOTIFY cap: ids and keys are dropped, `unchanged` still names the gate", async () => {
    await testDb.db.execute(
      sql`INSERT INTO rt_hosts (id, title, n, secret)
          SELECT 'host-' || lpad(i::text, 6, '0'), 't', 0, 's'
          FROM generate_series(1, 600) AS i`,
    );
    await testDb.db.execute(
      sql`INSERT INTO rt_side (id, host, score)
          SELECT 'side-' || id, id, 0 FROM rt_hosts WHERE id LIKE 'host-%'`,
    );
    await drain();
    await testDb.db.execute(
      sql`UPDATE rt_hosts SET secret = 'z' WHERE id LIKE 'host-%'`,
    );
    await testDb.db.execute(
      sql`UPDATE rt_side SET score = 1 WHERE id LIKE 'side-%'`,
    );
    const [hosts, side] = await drain();
    expect(hosts!.ids).toBeNull();
    expect(hosts!.keys).toBeNull();
    // Exact whatever the row count: a bulk write the narrow route can skip.
    expect(hosts!.unchanged).toEqual(["id", "n", "title"]);
    expect(side!.ids).toBeNull();
    expect(side!.keys).toBeNull();
    expect(side!.unchanged).toBeNull();
  });

  test("the changelog replays exactly what the NOTIFY carried", async () => {
    await drain();
    const before = await testDb.db.execute<{ seq: string }>(
      sql`SELECT coalesce(max(seq), 0)::text AS seq FROM live_state_changelog`,
    );
    const floor = before.rows[0]!.seq;
    await testDb.db.execute(
      sql`UPDATE rt_side SET host = 'h7' WHERE id = 's1'`,
    );
    await testDb.db.execute(
      sql`UPDATE rt_hosts SET title = 'B2' WHERE id = 'b'`,
    );
    await testDb.db.execute(sql`DELETE FROM rt_values WHERE view_id = 'w'`);
    const live = await drain();
    const log = await testDb.db.execute<{
      t: string;
      op: "I" | "U" | "D";
      ids: string[] | null;
      keys: unknown;
      unchanged: string[] | null;
    }>(
      sql`SELECT t, op, ids, keys, unchanged FROM live_state_changelog
          WHERE seq > ${floor}::bigint ORDER BY seq`,
    );
    expect(
      log.rows.map((r) => ({
        table: r.t,
        op: r.op,
        ids: r.ids,
        keys: parseKeyLayout(r.keys),
        unchanged: r.unchanged,
      })),
    ).toEqual(
      live.map((c) => ({
        table: c.table,
        op: c.op,
        ids: c.ids,
        keys: c.keys,
        unchanged: c.unchanged,
      })),
    );
  });
});

describe("A3 — the installed layout, read back from the catalog", () => {
  test("covers every route's carried columns", async () => {
    const installed = installedLayouts(
      await readInstalledTriggers(
        testDb.db,
        LAYOUTS.map((l) => l.table),
      ),
    );
    expect(findLayoutViolations(LAYOUTS, installed)).toEqual([]);
  });

  test("a route reading a column the trigger does not carry is a violation, per trigger", async () => {
    const installed = installedLayouts(
      await readInstalledTriggers(testDb.db, ["rt_side", "rt_plain"]),
    );
    expect(
      findLayoutViolations(
        [
          { table: "rt_side", carry: ["host", "score"], reads: [] },
          { table: "rt_plain", carry: [], reads: [] },
        ],
        installed,
      ),
    ).toEqual([
      {
        table: "rt_side",
        trigger: "live_state_rt_side_d",
        kind: "carry",
        missing: ["score"],
      },
      {
        table: "rt_side",
        trigger: "live_state_rt_side_i",
        kind: "carry",
        missing: ["score"],
      },
      {
        table: "rt_side",
        trigger: "live_state_rt_side_u",
        kind: "carry",
        missing: ["score"],
      },
      // A routed table on the PK-only function misses the routed trigger itself.
      { table: "rt_plain", trigger: "live_state_rt_plain_d", kind: "unrouted" },
      { table: "rt_plain", trigger: "live_state_rt_plain_i", kind: "unrouted" },
      { table: "rt_plain", trigger: "live_state_rt_plain_u", kind: "unrouted" },
    ]);
  });

  test("the installed gate is never a violation — `unchanged` lists only what it compared", async () => {
    // A route reading `secret`, which the installed gate does not compare:
    // `unchanged` never names it, so that route is reached on every UPDATE.
    const installed = installedLayouts(
      await readInstalledTriggers(testDb.db, ["rt_hosts"]),
    );
    expect(installed.get("rt_hosts")!.pk).toBe("id");
    expect(
      findLayoutViolations(
        [{ table: "rt_hosts", carry: [], reads: [["id", "secret"]] }],
        installed,
      ),
    ).toEqual([]);
  });

  test("a trigger keyed on another column than the table's primary key is a violation", () => {
    const installed = installedLayouts(
      (["i", "u", "d"] as const).map((op) => ({
        table: "rt_hosts",
        trigger: `live_state_rt_hosts_${op}`,
        fn: "live_state_notify_routed",
        args: ["title", "[]", "[]"],
        pk: "id",
      })),
    );
    expect(
      findLayoutViolations(
        [{ table: "rt_hosts", carry: [], reads: [] }],
        installed,
      ),
    ).toContainEqual({
      table: "rt_hosts",
      trigger: "live_state_rt_hosts_u",
      kind: "pk",
      installed: "title",
      expected: "id",
    });
  });

  test("a composite-keyed table's routed trigger is keyed on '' and passes", async () => {
    const installed = installedLayouts(
      await readInstalledTriggers(testDb.db, ["rt_values"]),
    );
    expect(installed.get("rt_values")!.pk).toBe("");
    expect(findLayoutViolations([LAYOUTS[2]!], installed)).toEqual([]);
  });

  test("a route naming a column its table does not have fails the rebuild", async () => {
    const error = await rebuildTriggers(testDb.db, NO_EXCLUSIONS, [
      { table: "rt_side", carry: ["nope"], reads: [] },
    ]).then(
      () => null,
      (err: unknown) => err,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(
      /"nope" of "rt_side", which the table does not have/,
    );
  });
});

describe("resolveLayout — which columns an UPDATE compares", () => {
  const columns = ["id", "type", "config", "enabled", "status", "body"];
  const req = (...reads: (readonly string[])[]): TableLayoutRequirement => ({
    table: "t",
    carry: [],
    reads,
  });

  test("one narrow route beside a whole-table one: only the narrow route's columns (a status flip must reach nothing, `body` is never compared)", () => {
    expect(
      resolveLayout(
        req(columns, ["config", "enabled", "id", "type"]),
        columns,
        "id",
      ).gate,
    ).toEqual(["config", "enabled", "id", "type"]);
  });

  test("several narrow routes: their union", () => {
    expect(
      resolveLayout(req(["id", "type"], ["enabled", "id"]), columns, "id").gate,
    ).toEqual(["enabled", "id", "type"]);
  });

  test("every route reads every column: nothing could skip, so no gate", () => {
    expect(resolveLayout(req(columns), columns, "id").gate).toEqual([]);
  });

  test("a composite / missing PK: old and new rows cannot pair up, so no gate", () => {
    expect(resolveLayout(req(["id", "type"]), columns, "").gate).toEqual([]);
  });

  test("a route reading a column the table does not have throws", () => {
    expect(() => resolveLayout(req(["id", "nope"]), columns, "id")).toThrow(
      /reads column\(s\) "nope" of "t"/,
    );
  });
});
