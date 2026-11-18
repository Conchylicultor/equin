/**
 * The GitHub arm's outcome mapping, on a real Postgres — evaluated over
 * parameters, so the suite needs no table.
 *
 * Run: `./equin test plugins/integrations/plugins/github-events/plugins/runs-arm`.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import {
  createTestDb,
  type TestDb,
} from "@plugins/database/plugins/db-test-fixture/server/testing";
import { githubOutcomeExpr } from "./outcome-sql";

let t: TestDb;

beforeAll(async () => {
  t = await createTestDb({ prefix: "github_runs_arm_test" });
});

afterAll(async () => {
  await t.drop();
});

async function outcomeOf(
  status: string,
  conclusion: string | null,
): Promise<string | null> {
  const rows = await t.db.execute<{ outcome: string | null }>(
    sql`select ${githubOutcomeExpr(sql`${status}::text`, sql`${conclusion}::text`)} as outcome`,
  );
  const row = rows.rows[0];
  if (!row) throw new Error("the evaluation query returned no row");
  return row.outcome;
}

describe("GitHub run outcome", () => {
  test.each([
    ["queued", null, "running"],
    ["in_progress", null, "running"],
    ["completed", "success", "succeeded"],
    ["completed", "skipped", "succeeded"],
    ["completed", "cancelled", "canceled"],
    ["completed", "action_required", "needs-approval"],
    ["completed", "failure", "failed"],
    ["completed", "timed_out", "failed"],
    ["completed", "some_new_word", "failed"],
    ["completed", null, "failed"],
  ] as const)("%s / %s → %s", async (status, conclusion, outcome) => {
    expect(await outcomeOf(status, conclusion)).toBe(outcome);
  });
});
