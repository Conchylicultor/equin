/**
 * The release arm's outcome mapping, on a real Postgres.
 *
 * Smaller than the build arm's suite because there is far less to get wrong:
 * `release_runs.status` is already a three-value closed set, so the mapping is
 * one-to-one and there is no second encoding to drift against. What IS worth
 * evidence is the claim the expression makes by having no `else` — that a status
 * the map does not cover projects NULL, so `RunOutcomeSchema` throws rather than
 * an unlabelled row reaching the list. That is exactly the kind of assertion
 * that is easy to write in a comment and quietly untrue in SQL.
 *
 * The expression is evaluated over a parameter rather than over `release_runs`,
 * so the suite needs no table, no migration chain and no fixture rows.
 *
 * Run: `./equin test plugins/release/plugins/runs-arm`
 * (requires the running embedded cluster — `./equin build` first).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import type { ReleaseRun } from "@plugins/release/core";
import type { RunOutcome } from "@plugins/runs/plugins/run-outcome/core";
import {
  createTestDb,
  type TestDb,
} from "@plugins/database/plugins/db-test-fixture/server/testing";
import { releaseOutcomeExpr } from "./outcome-sql";

let t: TestDb;

beforeAll(async () => {
  t = await createTestDb({ prefix: "release_runs_arm_test" });
});

afterAll(async () => {
  await t.drop();
});

async function outcomeOf(status: string): Promise<string | null> {
  const rows = await t.db.execute<{ outcome: string | null }>(
    sql`select ${releaseOutcomeExpr(sql`${status}::text`)} as outcome`,
  );
  const row = rows.rows[0];
  if (!row) throw new Error("the evaluation query returned no row");
  return row.outcome;
}

/** Restated independently of the map the expression is generated from. */
const EXPECTED: Record<ReleaseRun["status"], RunOutcome> = {
  running: "running",
  succeeded: "succeeded",
  failed: "failed",
};

describe("releaseOutcomeExpr", () => {
  for (const [status, expected] of Object.entries(EXPECTED)) {
    test(`${status} reads as ${expected}`, async () => {
      expect(await outcomeOf(status)).toBe(expected);
    });
  }

  test("a status the map does not cover projects NULL, not a guess", async () => {
    // The point of having no `else`. If someone adds a fourth release status and
    // forgets this map, the row does not quietly arrive as `failed` or as its own
    // native word — it arrives as NULL and RunOutcomeSchema refuses it.
    expect(await outcomeOf("canceled")).toBeNull();
    expect(await outcomeOf("")).toBeNull();
  });
});
