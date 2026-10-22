import { sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@plugins/database/server";
import { executeRows } from "@plugins/database/plugins/sql-rows/core";
import type { PushBucket } from "../../shared/values";
import { completedPushes, msToSeconds } from "./read-pushes";

const Row = z.object({
  bucket: z.string(),
  avg_ms: z.coerce.number(),
  max_ms: z.coerce.number(),
  contested: z.coerce.number(),
  total: z.coerce.number(),
});

// Avg / max wait per bucket, in seconds, over the CONTESTED pushes only (those
// that blocked at all); `contested` / `total` say how many that was. The wait is
// the derived `sum(waits)` — every wait the push blocked on, including the
// nested host-grant wait inside its checks step, which the legacy log never
// recorded: the chart measures "time this push spent blocked".
export async function loadWaitTime({ bucket }: { bucket: PushBucket }) {
  const rows = await executeRows(db, {
    label: "stats.pushes:wait-time",
    row: Row,
    query: sql`
      SELECT bucket,
             coalesce(avg(closed_wait_ms) FILTER (WHERE closed_wait_ms > 0), 0)::float8 AS avg_ms,
             coalesce(max(closed_wait_ms) FILTER (WHERE closed_wait_ms > 0), 0)::float8 AS max_ms,
             count(*) FILTER (WHERE closed_wait_ms > 0)::int AS contested,
             count(*)::int AS total
        FROM ${completedPushes(bucket)} p
       GROUP BY bucket
       ORDER BY bucket`,
  });
  return {
    points: rows.map((r) => ({
      bucket: r.bucket,
      avg: msToSeconds(r.avg_ms),
      max: msToSeconds(r.max_ms),
      contested: r.contested,
      total: r.total,
    })),
  };
}
