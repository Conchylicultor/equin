/**
 * A database with no `build_runs` table in it — the machine's VERY FIRST build.
 *
 * The base `singularity` database is created empty when the cluster starts, and
 * its schema arrives only when the backend restarts and migrates at the end of
 * the build that is running now. So the CLI's ledger write lands on a database
 * that exists and has no tables, and Postgres answers `42P01` where a
 * never-deployed checkout would have answered `3D000`. Both mean the same thing
 * — no ledger here yet — and both must degrade to the named `"unavailable"`
 * outcome rather than failing a build the ledger is only observing.
 *
 * `createTestDb()` hands back an UNMIGRATED database by construction: the
 * fixture applies schema only when the caller calls `runMigrations` itself (as
 * `stale-holder.test.ts` does). Not calling it IS the scenario.
 *
 * Run: `./singularity test plugins/build/plugins/run-ledger`
 * (requires the running embedded cluster — `./singularity build` first).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq, isNull } from "drizzle-orm";
import {
  createTestDb,
  type TestDb,
} from "@plugins/database/plugins/db-test-fixture/server/testing";
import { asNamespace } from "@plugins/infra/plugins/namespace/core";
import {
  closeRunOn,
  insertRunOn,
  type InsertRunRow,
} from "../../shared/recorder";
import { _buildRuns } from "./tables";
import { buildRunIdKind } from "../../core/internal/id-kind";

const NS = asNamespace("ledger-missing-test");

let t: TestDb;

beforeAll(async () => {
  // NO runMigrations: this suite's whole subject is the tableless database.
  t = await createTestDb({ prefix: "build_runs_missing_test" });
});

afterAll(async () => {
  await t.drop();
});

function row(): InsertRunRow {
  return {
    id: `missing-ledger-test-${process.pid}`,
    targets: ["singularity"],
    trigger: "manual",
    commitHash: null,
    pid: process.pid,
  };
}

/**
 * Await `p` and return the Error it rejected with; throw if it resolved.
 * `expect(p).rejects.toThrow()` is typed `void` under bun:test — the same helper
 * `stale-holder.test.ts` carries next door.
 */
async function rejection(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (err) {
    return err as Error;
  }
  throw new Error("expected the promise to reject, but it resolved");
}

describe("a database with no build_runs table", () => {
  // The fixture is only worth what this test proves about it: that a write here
  // really does reach a missing table and is rejected with 42P01. Without it a
  // guard that swallowed everything — or a database that quietly had the table
  // after all — would pass the two tests below just as well.
  test("the unguarded write is rejected with 42P01", async () => {
    const err = await rejection(
      t.db
        .update(_buildRuns)
        .set({ finishedAt: new Date(), exitCode: 0 })
        .where(
          and(
            eq(_buildRuns.id, buildRunIdKind.key(row().id)),
            isNull(_buildRuns.finishedAt),
          ),
        ),
    );
    expect((err as { code?: string }).code).toBe("42P01");
  });

  test('insertRun answers "unavailable" instead of throwing', async () => {
    expect(await insertRunOn(t.db, NS, row())).toBe("unavailable");
  });

  test("closeRun resolves on a row that was never minted", async () => {
    // No assertion beyond resolving: the point is that the build's own close
    // path does not throw `relation "build_runs" does not exist` at it. The
    // stamp it performs when the table IS there is pinned in
    // `stale-holder.test.ts`, which owns the migrated database.
    await closeRunOn(t.db, row().id, 0);
  });
});
