import { sql, type SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import type {
  ProducerBuilder,
  ProducerExecutor,
} from "@plugins/database/plugins/change-feed/server";
import { OTHER_VARIANT, VARIANT_CAP } from "../../core";
import type { SlowOpCallerValues, SlowOpRowValues } from "./fold-batch";
import { _slowOpCallers, _slowOps } from "./tables";

// The batch upserts, built and not executed (the producers run them). Each
// merges a folded batch row (fold-batch.ts) onto the stored row INSIDE the
// statement — every SET expression reads the row ON CONFLICT locked, so two
// backends writing the same op during a hot swap cannot lose an update, and no
// JS runs under the lock. The JSON merges mirror the pure merges in
// fold-batch.ts / merge-detail.ts; the suite checks they agree (see
// fold-batch.ts for the one place they may name a different variant).

// The proposed row's column, by its DB name — so a rename is a tsc error here
// rather than a string drifting from the schema.
const excluded = (column: PgColumn): SQL =>
  sql.raw(`excluded."${column.name}"`);

const t = _slowOps;

// The newest occurrence's attribution wins (a tie goes to the batch — the
// later arrival). SET expressions all read the PRE-update row, so every guard
// sees the same stored last_seen_at.
const batchIsNewest = sql`${excluded(t.lastSeenAt)} >= ${t.lastSeenAt}`;

// waits: sum per layer over both maps.
const mergedWaits = sql`(
  SELECT coalesce(jsonb_object_agg(layer, total), '{}'::jsonb)
  FROM (
    SELECT layer, sum(ms::float8) AS total
    FROM (
      SELECT * FROM jsonb_each_text(${t.waits})
      UNION ALL
      SELECT * FROM jsonb_each_text(${excluded(t.waits)})
    ) AS u(layer, ms)
    GROUP BY layer
  ) AS g
)`;

// recentSamples: the newest 10 of both rings by atTime; on a tie the batch's
// samples (newer arrivals) come first, each ring keeping its own order —
// mergeSample's stable sort with each new sample prepended.
const mergedSamples = sql`(
  SELECT coalesce(jsonb_agg(e ORDER BY at DESC, src, ord), '[]'::jsonb)
  FROM (
    SELECT e, at, src, ord
    FROM (
      SELECT e, (e ->> 'atTime')::timestamptz AS at, 0 AS src, ord
      FROM jsonb_array_elements(${excluded(t.recentSamples)}) WITH ORDINALITY AS a(e, ord)
      UNION ALL
      SELECT e, (e ->> 'atTime')::timestamptz AS at, 1 AS src, ord
      FROM jsonb_array_elements(${t.recentSamples}) WITH ORDINALITY AS b(e, ord)
    ) AS u
    ORDER BY at DESC, src, ord
    LIMIT 10
  ) AS top
)`;

// variants: sum per variant over both lists, keep the top VARIANT_CAP named by
// totalMs, fold the rest (and any existing "(other)") into one "(other)" —
// mergeVariant's bound, so the row cannot grow without limit.
const mergedVariants = sql`(
  WITH u AS (
    SELECT e ->> 'variant' AS v, (e ->> 'count')::int AS c,
           (e ->> 'totalMs')::float8 AS tot, (e ->> 'maxMs')::float8 AS mx
    FROM jsonb_array_elements(${t.variants} || ${excluded(t.variants)}) AS e
  ),
  g AS (
    SELECT v, sum(c) AS c, sum(tot) AS tot, max(mx) AS mx FROM u GROUP BY v
  ),
  r AS (
    SELECT g.*,
           CASE WHEN v = ${OTHER_VARIANT}::text THEN NULL
                ELSE row_number() OVER (
                  PARTITION BY v = ${OTHER_VARIANT}::text ORDER BY tot DESC, v
                ) END AS rn
    FROM g
  ),
  f AS (
    SELECT CASE WHEN rn IS NOT NULL AND rn <= ${VARIANT_CAP}::int THEN v
                ELSE ${OTHER_VARIANT}::text END AS v,
           sum(c) AS c, sum(tot) AS tot, max(mx) AS mx
    FROM r GROUP BY 1
  )
  SELECT coalesce(
    jsonb_agg(
      jsonb_build_object('variant', v, 'count', c, 'totalMs', tot, 'maxMs', mx)
      ORDER BY v = ${OTHER_VARIANT}::text, tot DESC, v
    ),
    '[]'::jsonb
  )
  FROM f
)`;

// measures: per measure, the larger max and the batch's last (the later
// arrival) — mergeMeasures.
const mergedMeasures = sql`(
  SELECT coalesce(
    jsonb_object_agg(
      k,
      CASE
        WHEN n IS NULL THEN o
        WHEN o IS NULL THEN n
        ELSE jsonb_build_object(
          'max', greatest((o ->> 'max')::float8, (n ->> 'max')::float8),
          'last', n -> 'last'
        )
      END
    ),
    '{}'::jsonb
  )
  FROM (
    SELECT coalesce(o.key, n.key) AS k, o.value AS o, n.value AS n
    FROM jsonb_each(${t.measures}) AS o
    FULL JOIN jsonb_each(${excluded(t.measures)}) AS n ON o.key = n.key
  ) AS j
)`;

/** One batch's `slow_ops` upsert: one VALUES row per op, merged in SQL. */
export function buildOpUpsert(
  q: ProducerExecutor,
  table: typeof _slowOps,
  rows: SlowOpRowValues[],
): ProducerBuilder<typeof _slowOps> {
  return q
    .insert(table)
    .values(rows)
    .onConflictDoUpdate({
      target: [table.operationKind, table.operation, table.worktree],
      set: {
        count: sql`${table.count} + ${excluded(table.count)}`,
        totalMs: sql`${table.totalMs} + ${excluded(table.totalMs)}`,
        maxMs: sql`greatest(${table.maxMs}, ${excluded(table.maxMs)})`,
        lastMs: sql`case when ${batchIsNewest} then ${excluded(table.lastMs)} else ${table.lastMs} end`,
        thresholdMs: sql`case when ${batchIsNewest} then ${excluded(table.thresholdMs)} else ${table.thresholdMs} end`,
        firstSeenAt: sql`least(${table.firstSeenAt}, ${excluded(table.firstSeenAt)})`,
        lastSeenAt: sql`greatest(${table.lastSeenAt}, ${excluded(table.lastSeenAt)})`,
        waits: mergedWaits,
        recentSamples: mergedSamples,
        variants: mergedVariants,
        measures: mergedMeasures,
      },
    });
}

/** One batch's `slow_op_callers` upsert: additive counters per (op, caller). */
export function buildCallerUpsert(
  q: ProducerExecutor,
  table: typeof _slowOpCallers,
  rows: SlowOpCallerValues[],
): ProducerBuilder<typeof _slowOpCallers> {
  return q
    .insert(table)
    .values(rows)
    .onConflictDoUpdate({
      target: [
        table.operationKind,
        table.operation,
        table.worktree,
        table.callerKind,
        table.callerLabel,
      ],
      set: {
        count: sql`${table.count} + ${excluded(table.count)}`,
        totalMs: sql`${table.totalMs} + ${excluded(table.totalMs)}`,
        maxMs: sql`greatest(${table.maxMs}, ${excluded(table.maxMs)})`,
        firstSeenAt: sql`least(${table.firstSeenAt}, ${excluded(table.firstSeenAt)})`,
        lastSeenAt: sql`greatest(${table.lastSeenAt}, ${excluded(table.lastSeenAt)})`,
      },
    });
}
