import { z } from "zod";
import { and, eq, gt, inArray, notExists, sql } from "drizzle-orm";
import { db } from "@plugins/database/server";
import { defineJob } from "@plugins/infra/plugins/jobs/server";
import { RESULTS_KEPT_PER_FILE } from "../../core";
import { chunked } from "./db-exec";
import { recomputeFileStatus } from "./recompute";
import { _testCaseFailures, _testFileResults } from "./tables";

const CHUNK = 500;

/**
 * Keep the newest {@link RESULTS_KEPT_PER_FILE} results per test file (their
 * failing cases with them), then re-derive those files' status. A cap, not a
 * TTL: a file nobody touched for months keeps its only verdicts.
 */
export async function capResults(): Promise<{ deleted: number }> {
  const ranked = db.$with("ranked").as(
    db
      .select({
        id: _testFileResults.id,
        opId: _testFileResults.opId,
        path: _testFileResults.path,
        rn: sql`row_number() OVER (PARTITION BY ${_testFileResults.path} ORDER BY ${_testFileResults.finishedAt} DESC, ${_testFileResults.opId} DESC)`
          .mapWith(Number)
          .as("rn"),
      })
      .from(_testFileResults),
  );
  const over = await db
    .with(ranked)
    .select({ id: ranked.id, opId: ranked.opId, path: ranked.path })
    .from(ranked)
    .where(gt(ranked.rn, RESULTS_KEPT_PER_FILE));
  for (const c of chunked(over, CHUNK))
    await db.delete(_testFileResults).where(
      inArray(
        _testFileResults.id,
        c.map((r) => r.id),
      ),
    );
  // A failing case outlives no result of its file in its run.
  if (over.length > 0)
    await db.delete(_testCaseFailures).where(
      notExists(
        db
          .select({ one: sql`1` })
          .from(_testFileResults)
          .where(
            and(
              eq(_testFileResults.opId, _testCaseFailures.opId),
              eq(_testFileResults.path, _testCaseFailures.path),
            ),
          ),
      ),
    );
  await recomputeFileStatus(db, [...new Set(over.map((r) => r.path))]);
  return { deleted: over.length };
}

export const resultsCapJob = defineJob({
  name: "tests.results-cap",
  description:
    "Keeps the newest 32 harvested results of each test file (and their failing cases) so the test-status tables stay bounded without forgetting a stable file's last verdict.",
  hold: "instant",
  input: z.object({}),
  event: z.never(),
  dedup: "singleton",
  schedule: { cron: "50 4 * * *" }, // daily at 04:50 UTC
  async run() {
    await capResults();
  },
});
