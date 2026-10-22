import { sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@plugins/database/server";
import { executeRows } from "@plugins/database/plugins/sql-rows/core";
import type { PushBucket } from "../../shared/values";
import { completedPushes, msToSeconds } from "./read-pushes";

type StepGroup = "fetch" | "rebase" | "checks" | "push" | "other";

// Keyed on the step names the push CLI emits; anything unmapped falls to
// "other". Grouped here rather than in SQL so the table stays one readable map.
const STEP_GROUPS: Record<string, StepGroup> = {
  fetch: "fetch",
  "ff-main": "fetch",
  rebase: "rebase",
  checks: "checks",
  "push-branch": "push",
  "ff-merge": "push",
  "push-main": "push",
  "bun-install": "other",
  normalize: "other",
};

// One row per (bucket, step name), plus the bucket's push count — a bucket
// whose pushes recorded no step still appears (name null) so its average is 0,
// not missing.
const Row = z.object({
  bucket: z.string(),
  pushes: z.coerce.number(),
  name: z.string().nullable(),
  ms: z.coerce.number().nullable(),
});

// Avg seconds per push spent in each step group, per bucket.
export async function loadStepBreakdown({ bucket }: { bucket: PushBucket }) {
  const rows = await executeRows(db, {
    label: "stats.pushes:step-breakdown",
    row: Row,
    query: sql`
      WITH p AS ${completedPushes(bucket)},
           n AS (SELECT bucket, count(*)::int AS pushes FROM p GROUP BY bucket),
           s AS (
             SELECT p.bucket, step->>'name' AS name,
                    sum((step->>'durationMs')::float8) AS ms
               FROM p CROSS JOIN LATERAL jsonb_array_elements(p.steps) AS step
              GROUP BY 1, 2
           )
      SELECT n.bucket, n.pushes, s.name, s.ms
        FROM n LEFT JOIN s USING (bucket)
       ORDER BY n.bucket`,
  });

  const buckets = new Map<
    string,
    { pushes: number; sums: Record<StepGroup, number> }
  >();
  for (const r of rows) {
    let entry = buckets.get(r.bucket);
    if (!entry) {
      entry = {
        pushes: r.pushes,
        sums: { fetch: 0, rebase: 0, checks: 0, push: 0, other: 0 },
      };
      buckets.set(r.bucket, entry);
    }
    if (r.name !== null && r.ms !== null)
      entry.sums[STEP_GROUPS[r.name] ?? "other"] += r.ms;
  }

  const avg = (
    e: { pushes: number; sums: Record<StepGroup, number> },
    g: StepGroup,
  ) => msToSeconds(e.sums[g] / e.pushes);
  return {
    points: [...buckets.entries()].map(([bucket, e]) => ({
      bucket,
      fetch: avg(e, "fetch"),
      rebase: avg(e, "rebase"),
      checks: avg(e, "checks"),
      push: avg(e, "push"),
      other: avg(e, "other"),
    })),
  };
}
