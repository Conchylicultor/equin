/**
 * The anti-drift suite for the one rule this arm has to write twice.
 *
 * `buildStatusOf` (TypeScript, over a fetched row) and `buildStatusExpr` (SQL,
 * inside the union's projection) decide the same thing about the same two
 * fields. Nothing in the type system can tie a `case … end` string to a chain of
 * `if`s, so this is the strongest available guard: every branch of the rule, and
 * both sides of every boundary it draws, driven through BOTH encodings on a real
 * Postgres and asserted equal.
 *
 * The expression is evaluated over parameters rather than over `build_runs`, so
 * the suite needs no table, no migration chain and no fixture rows — only a
 * server that can answer `SELECT`. That is also why `buildStatusExpr` takes its
 * two columns as arguments instead of closing over the table.
 *
 * Run: `./equin test plugins/build/plugins/runs-arm`
 * (requires the running embedded cluster — `./equin build` first).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import {
  buildStatusOf,
  type BuildRunOutcome,
  type BuildStatus,
} from "@plugins/build/plugins/build-status/core";
import type { RunOutcome } from "@plugins/runs/plugins/run-outcome/core";
import {
  createTestDb,
  type TestDb,
} from "@plugins/database/plugins/db-test-fixture/server/testing";
import { buildOutcomeExpr, buildStatusExpr } from "./status-sql";

let t: TestDb;

beforeAll(async () => {
  t = await createTestDb({ prefix: "build_runs_arm_test" });
});

afterAll(async () => {
  await t.drop();
});

const FINISHED = new Date("2026-08-07T12:00:00Z");

/**
 * Every sample the rule can distinguish. Boundaries are paired on purpose —
 * 128 vs 129 is the whole of the `killed` test, and 0 vs 1 the whole of
 * `success`.
 */
const SAMPLES: BuildRunOutcome[] = [
  // In flight: the exit code must not matter, whatever it says.
  { finishedAt: null, exitCode: null },
  { finishedAt: null, exitCode: 0 },
  { finishedAt: null, exitCode: 1 },
  { finishedAt: null, exitCode: 75 },
  { finishedAt: null, exitCode: -1 },
  { finishedAt: null, exitCode: 143 },
  // Finished, verdict given.
  { finishedAt: FINISHED, exitCode: 0 },
  { finishedAt: FINISHED, exitCode: 1 },
  { finishedAt: FINISHED, exitCode: 2 },
  // The pre-Step-0 killed path recorded no code at all.
  { finishedAt: FINISHED, exitCode: null },
  // BUILD_EXIT_SUPERSEDED, and its neighbours on both sides.
  { finishedAt: FINISHED, exitCode: 74 },
  { finishedAt: FINISHED, exitCode: 75 },
  { finishedAt: FINISHED, exitCode: 76 },
  // Hard-killed owner, and the numbers either side of it.
  { finishedAt: FINISHED, exitCode: -2 },
  { finishedAt: FINISHED, exitCode: -1 },
  // The signal boundary: 128 is not a signal death, 129 is.
  { finishedAt: FINISHED, exitCode: 127 },
  { finishedAt: FINISHED, exitCode: 128 },
  { finishedAt: FINISHED, exitCode: 129 },
  { finishedAt: FINISHED, exitCode: 130 },
  { finishedAt: FINISHED, exitCode: 137 },
  { finishedAt: FINISHED, exitCode: 143 },
  { finishedAt: FINISHED, exitCode: 255 },
];

function label(run: BuildRunOutcome): string {
  return `finishedAt=${run.finishedAt === null ? "null" : "set"} exitCode=${String(run.exitCode)}`;
}

/**
 * Evaluate both SQL expressions over one sample, casting the parameters to the
 * column types the real projection binds — `timestamptz` and `integer` — so the
 * comparisons resolve exactly as they do against `build_runs`.
 */
async function evaluate(
  run: BuildRunOutcome,
): Promise<{ status: string; outcome: string | null }> {
  const finishedAt = sql`${run.finishedAt}::timestamptz`;
  const exitCode = sql`${run.exitCode}::integer`;
  const statusExpr = buildStatusExpr(finishedAt, exitCode);
  const rows = await t.db.execute<{ status: string; outcome: string | null }>(
    sql`select ${statusExpr} as status, ${buildOutcomeExpr(statusExpr)} as outcome`,
  );
  const row = rows.rows[0];
  if (!row) throw new Error("the evaluation query returned no row");
  return row;
}

/** The collapse, restated independently of the map the expression is built from. */
const EXPECTED_OUTCOME: Record<BuildStatus, RunOutcome> = {
  running: "running",
  success: "succeeded",
  failed: "failed",
  superseded: "canceled",
  interrupted: "canceled",
  killed: "canceled",
};

describe("buildStatusExpr agrees with buildStatusOf", () => {
  for (const run of SAMPLES) {
    test(label(run), async () => {
      const { status } = await evaluate(run);
      expect(status).toBe(buildStatusOf(run));
    });
  }
});

describe("buildOutcomeExpr collapses onto the shared axis", () => {
  for (const run of SAMPLES) {
    test(label(run), async () => {
      const { outcome } = await evaluate(run);
      expect(outcome).toBe(EXPECTED_OUTCOME[buildStatusOf(run)]);
    });
  }

  test("every build status the taxonomy has is covered", () => {
    // If a seventh BuildStatus appears, this suite's own map fails to compile —
    // and so does the one the expression is generated from. Both have to be
    // extended, which is the point of writing them twice.
    const statuses = new Set(SAMPLES.map(buildStatusOf));
    expect([...statuses].sort()).toEqual(
      (Object.keys(EXPECTED_OUTCOME) as BuildStatus[]).sort(),
    );
  });
});
