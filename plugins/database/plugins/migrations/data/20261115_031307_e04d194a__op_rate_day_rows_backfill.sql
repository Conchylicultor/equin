-- Custom SQL migration file, put your code below! --
-- migration: 20261115_031307__op_rate_day_rows_backfill --
-- op-rate's history moves to one row per op and UTC day, its counters an
-- array (plugins/debug/plugins/op-rate/server/internal/tables.ts): element i
-- (0-based; i + 1 in SQL) is bucket i's windows, or hour i's calls. Idempotent:
-- a row already in the new table is kept, so a re-run (the deferred contract)
-- leaves what the new code has written since.

INSERT INTO "op_rate_day_buckets" ("op", "regime", "day_start", "windows")
SELECT g.op, g.regime, g.day_start,
       array_agg(coalesce(c.windows, 0) ORDER BY s.b)
FROM (
  SELECT op, regime, day_start, max(bucket)::int AS top
  FROM "op_rate_window_counts"
  GROUP BY op, regime, day_start
) AS g
CROSS JOIN LATERAL generate_series(0, g.top) AS s(b)
LEFT JOIN "op_rate_window_counts" AS c
  ON c.op = g.op AND c.regime = g.regime AND c.day_start = g.day_start
 AND c.bucket = s.b
GROUP BY g.op, g.regime, g.day_start
ON CONFLICT DO NOTHING;

INSERT INTO "op_rate_day_hours" ("op", "day_start", "calls")
SELECT g.op, g.day_start,
       array_agg(coalesce(h.calls, 0) ORDER BY s.i)
FROM (
  SELECT op, date_trunc('day', hour_start, 'UTC') AS day_start,
         max(extract(hour FROM hour_start AT TIME ZONE 'UTC'))::int AS top
  FROM "op_rate_hour_calls"
  GROUP BY 1, 2
) AS g
CROSS JOIN LATERAL generate_series(0, g.top) AS s(i)
LEFT JOIN "op_rate_hour_calls" AS h
  ON h.op = g.op AND h.hour_start = g.day_start + s.i * interval '1 hour'
GROUP BY g.op, g.day_start
ON CONFLICT DO NOTHING;
