import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { sql } from "drizzle-orm";
import { Client } from "pg";
import {
  createTestDb,
  type TestDb,
} from "@plugins/database/plugins/db-test-fixture/server/testing";
import {
  defineDbTriggers,
  installDbTriggers,
  type DbTriggerSet,
} from "@plugins/database/plugins/db-triggers/server";

// The installer's two call shapes beside the schema layer's: a sweep that
// spares a set another call installs (claimed with `DbTriggerClaim`), and the
// per-table commit mode. The stamp / adoption / ownership protocol is pinned
// by the rollup oracle (beside this file) and the change feed's suite. Here,
// not in db-triggers: the throwaway-database fixture reaches the migrations
// plugin, which imports db-triggers — a test there would close a cycle.

let testDb: TestDb;

function touchSet(id: string, table: string): DbTriggerSet {
  const fn = `${id.replace(/\W/g, "_")}_fn`;
  return defineDbTriggers({
    id,
    functions: [
      {
        name: fn,
        args: "",
        ddl: `CREATE OR REPLACE FUNCTION ${fn}() RETURNS trigger AS $f$ BEGIN RETURN NULL; END; $f$ LANGUAGE plpgsql`,
      },
    ],
    triggers: [
      {
        name: `${fn}_t`,
        table,
        ddl: `CREATE OR REPLACE TRIGGER ${fn}_t AFTER INSERT ON ${table} FOR EACH STATEMENT EXECUTE FUNCTION ${fn}()`,
      },
    ],
  });
}

async function triggerNames(): Promise<string[]> {
  const res = await testDb.db.execute<{ tgname: string }>(
    sql`SELECT tgname FROM pg_trigger WHERE NOT tgisinternal ORDER BY tgname`,
  );
  return res.rows.map((r) => r.tgname);
}

beforeAll(async () => {
  testDb = await createTestDb({ prefix: "dbtrig_test" });
  await testDb.db.execute(
    sql.raw(
      `CREATE TABLE t_a (id text PRIMARY KEY); CREATE TABLE t_b (id text PRIMARY KEY);`,
    ),
  );
});

afterAll(async () => {
  await testDb?.drop();
});

describe("sweep", () => {
  test("drops a stamped set nobody declares, and spares one installed elsewhere", async () => {
    const layer = touchSet("layer.a", "t_a");
    const elsewhere = touchSet("elsewhere.b", "t_b");
    await installDbTriggers(testDb.db, [elsewhere], { commit: "per-table" });
    await installDbTriggers(testDb.db, [layer], {
      sweep: { schema: "public", installedElsewhere: ["elsewhere.b"] },
    });
    expect(await triggerNames()).toEqual(["elsewhere_b_fn_t", "layer_a_fn_t"]);

    const swept = await installDbTriggers(testDb.db, [layer], {
      sweep: { schema: "public" },
    });
    expect(swept).toContainEqual({ id: "elsewhere.b", outcome: "dropped" });
    expect(await triggerNames()).toEqual(["layer_a_fn_t"]);
  });

  test("refuses a set both declared and claimed as installed elsewhere", async () => {
    const layer = touchSet("layer.a", "t_a");
    expect(
      installDbTriggers(testDb.db, [layer], {
        sweep: { schema: "public", installedElsewhere: ["layer.a"] },
      }),
    ).rejects.toThrow(/both declared here and claimed/);
  });
});

describe('commit: "per-table"', () => {
  test("refuses a transaction: it commits each table on its own", async () => {
    await testDb.db.transaction(async (tx) => {
      expect(
        installDbTriggers(
          tx as unknown as typeof testDb.db,
          [touchSet("pt.a", "t_a")],
          { commit: "per-table" },
        ),
      ).rejects.toThrow(/takes the pool, never a transaction/);
    });
  });

  test("commits each table before taking the next: a writer on the later one never holds back the earlier", async () => {
    const set = defineDbTriggers({
      id: "pt.ab",
      functions: [
        {
          name: "pt_ab_fn",
          args: "",
          ddl: `CREATE OR REPLACE FUNCTION pt_ab_fn() RETURNS trigger AS $f$ BEGIN RETURN NULL; END; $f$ LANGUAGE plpgsql`,
        },
      ],
      triggers: ["t_a", "t_b"].map((table) => ({
        name: `pt_ab_${table}`,
        table,
        ddl: `CREATE OR REPLACE TRIGGER pt_ab_${table} AFTER INSERT ON ${table} FOR EACH STATEMENT EXECUTE FUNCTION pt_ab_fn()`,
      })),
    });
    // The suite's `db` is one connection, busy with the install while it
    // waits: watch from a session of our own.
    const writer = new Client({ connectionString: testDb.connectionString });
    const observer = new Client({ connectionString: testDb.connectionString });
    await writer.connect();
    await observer.connect();
    const observed = async () =>
      (
        await observer.query<{ tgname: string }>(
          "SELECT tgname FROM pg_trigger WHERE NOT tgisinternal",
        )
      ).rows.map((r) => r.tgname);
    try {
      await writer.query("BEGIN");
      await writer.query("INSERT INTO t_b VALUES ('held')");
      const install = installDbTriggers(testDb.db, [set], {
        commit: "per-table",
      });
      const deadline = Date.now() + 10_000;
      let names = await observed();
      while (!names.includes("pt_ab_t_a") && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
        names = await observed();
      }
      // t_a committed (seen from another session) while t_b still waits.
      expect(names).toContain("pt_ab_t_a");
      expect(names).not.toContain("pt_ab_t_b");
      await writer.query("ROLLBACK");
      expect(await install).toEqual([{ id: "pt.ab", outcome: "installed" }]);
    } finally {
      await writer.end();
      await observer.end();
    }
    expect(await triggerNames()).toContain("pt_ab_t_b");
  }, 30_000);

  // Each table re-plans under its lock from that table's catalog alone (a
  // whole-set read there made the install O(tables²)). The scope names the
  // relation by schema and name, so a quoted, mixed-case table is still
  // found — its stale trigger dropped, its current one left alone.
  test("re-plans each table from its own catalog: a quoted table's triggers are replaced and dropped", async () => {
    await testDb.db.execute(
      sql.raw(`CREATE TABLE "T_Mixed" (id text PRIMARY KEY)`),
    );
    const fn = {
      name: "pt_mixed_fn",
      args: "",
      ddl: `CREATE OR REPLACE FUNCTION pt_mixed_fn() RETURNS trigger AS $f$ BEGIN RETURN NULL; END; $f$ LANGUAGE plpgsql`,
    };
    const trigger = (name: string, table: string) => ({
      name,
      table,
      ddl: `CREATE OR REPLACE TRIGGER ${name} AFTER INSERT ON "${table}" FOR EACH STATEMENT EXECUTE FUNCTION pt_mixed_fn()`,
    });
    const both = defineDbTriggers({
      id: "pt.mixed",
      functions: [fn],
      triggers: [
        trigger("pt_mixed_keep", "T_Mixed"),
        trigger("pt_mixed_gone", "T_Mixed"),
        trigger("pt_mixed_a", "t_a"),
      ],
    });
    expect(
      await installDbTriggers(testDb.db, [both], { commit: "per-table" }),
    ).toEqual([{ id: "pt.mixed", outcome: "installed" }]);
    expect(
      await installDbTriggers(testDb.db, [both], { commit: "per-table" }),
    ).toEqual([{ id: "pt.mixed", outcome: "unchanged" }]);

    const fewer = defineDbTriggers({
      id: "pt.mixed",
      functions: [fn],
      triggers: [
        trigger("pt_mixed_keep", "T_Mixed"),
        trigger("pt_mixed_a", "t_a"),
      ],
    });
    expect(
      await installDbTriggers(testDb.db, [fewer], { commit: "per-table" }),
    ).toEqual([{ id: "pt.mixed", outcome: "installed" }]);
    const names = await triggerNames();
    expect(names).toContain("pt_mixed_keep");
    expect(names).toContain("pt_mixed_a");
    expect(names).not.toContain("pt_mixed_gone");
  });
});
