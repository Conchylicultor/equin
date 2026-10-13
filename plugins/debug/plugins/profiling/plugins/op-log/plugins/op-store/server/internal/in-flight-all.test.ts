/**
 * `op-store.in-flight.all` holds EVERY op in flight on the host: the op-status
 * banner and chips filter one shared read by worktree on the client, so an op
 * past the old window's `maxLimit` (500) — the newest, oldest first — must
 * still be in it, and a closed op must not. The real declaration, compiled
 * with the served binding against a throwaway database carrying the real
 * schema, loads the whole set FULL, oldest requested first.
 *
 * Requires a running Postgres cluster (started by ./singularity build).
 * Run: `./singularity test plugins/debug/plugins/profiling/plugins/op-log/plugins/op-store`.
 */

import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { sql } from "drizzle-orm";
import {
  createTestDb,
  type TestDb,
} from "@plugins/database/plugins/db-test-fixture/server/testing";
import { runMigrations } from "@plugins/database/plugins/migrations/server/testing";
import type { QueryDb } from "@plugins/infra/plugins/query-resource/server";
import { compileCollection } from "@plugins/network/plugins/live/server/testing";
import { opsInFlight } from "../../core";
import { opsInFlightWhere } from "./resources";
import { _opLogOps } from "./tables";

setDefaultTimeout(120_000);

/** The old window's `maxLimit`, plus one. */
const COUNT = 501;

let t: TestDb;

beforeAll(async () => {
  t = await createTestDb({ prefix: "op_store_in_flight_all" });
  await runMigrations(t.db);
  // Op `g` requested `g` seconds after the base, so op 501 is the newest; one
  // more op, closed, sits between them.
  await t.db.execute(sql`
    INSERT INTO op_log_ops (op_id, kind, branch, requested_at, waits, steps)
    SELECT 'op-' || g, 'build', 'b',
      timestamptz '2026-01-01' + g * interval '1 second', '[]', '[]'
    FROM generate_series(1, ${COUNT}) g`);
  await t.db.execute(sql`
    INSERT INTO op_log_ops (op_id, kind, branch, requested_at, waits, steps,
      outcome, closed_by)
    VALUES ('op-closed', 'build', 'b', timestamptz '2026-01-01', '[]', '[]',
      'success', 'self')`);
});

afterAll(async () => {
  await t?.drop();
});

test("the whole set holds the newest op past the old window's maxLimit, and no closed one", async () => {
  const specs = compileCollection(opsInFlight, {
    from: _opLogOps,
    where: opsInFlightWhere,
    db: t.db as unknown as QueryDb,
  });
  const rows = await specs.all.loader({});
  expect(rows).toHaveLength(COUNT);
  expect(rows[0]?.opId).toBe("op-1");
  // Oldest first: the newest op — the one the old window dropped — is last.
  expect(rows.at(-1)?.opId).toBe(`op-${COUNT}`);
  expect(rows.some((r) => r.opId === "op-closed")).toBe(false);
});
