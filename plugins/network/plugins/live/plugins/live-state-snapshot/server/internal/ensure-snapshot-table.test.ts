import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { executeRows } from "@plugins/database/plugins/sql-rows/core";
import {
  LIVE_STATE_CHANGELOG_HORIZON_TABLE,
  LIVE_STATE_HANDOFF_TABLE,
  LIVE_STATE_SNAPSHOT_TABLE,
} from "@plugins/database/plugins/derived-views/core";
import {
  createTestDb,
  type TestDb,
} from "@plugins/database/plugins/db-test-fixture/server/testing";
import { ensureSnapshotTable } from "./tables-ddl";

// Every boot runs `ensureSnapshotTable` — exec children too, against main's
// database while main serves. A table already in shape must take NO lock: an
// `ALTER TABLE … ADD COLUMN IF NOT EXISTS` takes ACCESS EXCLUSIVE even with
// nothing to do, and queued behind a fork's `pg_dump` it held every L2
// persist and boot-snapshot read for seconds. Also pins the in-place upgrades
// the catalog read now decides.

const L2_TABLES = [
  LIVE_STATE_SNAPSHOT_TABLE,
  LIVE_STATE_CHANGELOG_HORIZON_TABLE,
  LIVE_STATE_HANDOFF_TABLE,
];

let t: TestDb;

beforeEach(async () => {
  t = await createTestDb({ prefix: "lss_ddl_test" });
});

afterEach(async () => {
  await t.drop();
});

async function columnsOf(table: string): Promise<string[]> {
  const rows = await executeRows(t.db, {
    query: sql`SELECT attname FROM pg_attribute
      WHERE attrelid = to_regclass(${`public.${table}`})
        AND attnum > 0 AND NOT attisdropped ORDER BY attname`,
    row: z.object({ attname: z.string() }),
    label: "test/columns",
  });
  return rows.map((r) => r.attname);
}

const LockRowSchema = z.object({ relname: z.string(), mode: z.string() });

describe("ensureSnapshotTable", () => {
  test("creates every table with every column on an empty database", async () => {
    await ensureSnapshotTable(t.db);
    expect(await columnsOf(LIVE_STATE_SNAPSHOT_TABLE)).toEqual([
      "definition",
      "definition_at",
      "params_key",
      "persisted_at",
      "position",
      "position_at",
      "resource_key",
      "tables_read",
      "value",
    ]);
    expect(await columnsOf(LIVE_STATE_HANDOFF_TABLE)).toEqual([
      "code",
      "cut_xid",
      "epoch",
      "tuples",
      "written_at",
    ]);
    expect(await columnsOf(LIVE_STATE_CHANGELOG_HORIZON_TABLE)).toEqual([
      "id",
      "max_pruned_xid",
    ]);
  });

  test("upgrades an old-shape table in place", async () => {
    await t.db.execute(
      sql.raw(`CREATE TABLE ${LIVE_STATE_SNAPSHOT_TABLE} (
        resource_key text NOT NULL, params_key text NOT NULL,
        value jsonb NOT NULL, position numeric NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (resource_key, params_key))`),
    );
    await t.db.execute(
      sql.raw(`CREATE TABLE ${LIVE_STATE_HANDOFF_TABLE} (
        epoch text PRIMARY KEY, cut_xid numeric NOT NULL,
        tuples jsonb NOT NULL, written_at timestamptz NOT NULL DEFAULT now())`),
    );
    await ensureSnapshotTable(t.db);
    expect(await columnsOf(LIVE_STATE_SNAPSHOT_TABLE)).toEqual([
      "definition",
      "definition_at",
      "params_key",
      "persisted_at",
      "position",
      "position_at",
      "resource_key",
      "tables_read",
      "value",
    ]);
    expect(await columnsOf(LIVE_STATE_HANDOFF_TABLE)).toContain("code");
  });

  test("takes no lock on an L2 table already in shape", async () => {
    await ensureSnapshotTable(t.db);
    // In one transaction, every lock the call took is still held at its end.
    const held = await t.db.transaction(async (tx) => {
      await ensureSnapshotTable(tx);
      return executeRows(tx, {
        query: sql`SELECT c.relname, l.mode FROM pg_locks l
          JOIN pg_class c ON c.oid = l.relation
          WHERE l.pid = pg_backend_pid()
            AND c.relname = ANY(ARRAY[${sql.join(
              L2_TABLES.map((n) => sql`${n}`),
              sql`, `,
            )}]::text[])
            AND l.mode <> 'AccessShareLock'`,
        row: LockRowSchema,
        label: "test/locks",
      });
    });
    expect(held).toEqual([]);
  });
});
