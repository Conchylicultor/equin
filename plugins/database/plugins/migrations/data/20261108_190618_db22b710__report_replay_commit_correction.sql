-- Custom SQL migration file, put your code below! --
-- migration: 20261108_190618__report_replay_commit_correction --
-- One occurrence of report-1793823761-0xqf83 ("conversations_ext_sdk_agent_stop
-- .updated_at is derived") was stamped with the wrong commit and instant: the
-- crash buffer replayed it with the FLUSHING boot's pin and clock, not the
-- writer's (fixed in reports/engine `replayedReportInput`). Evidence (main's
-- gateway logs): the uncaught exception was raised at 17:21:05Z by pid 74247,
-- whose pin was 9b06a6dcc5 (its nine other occurrences, 17:21:03.9-05.5Z,
-- carry it) — code WITHOUT the fix 2baf0e2a3b. Main was then down until
-- 17:32:30Z, when a boot from HEAD dcc70defd9 replayed the line at 17:32:35.901Z
-- and stamped it dcc70defd9, which contains the fix — so the fix ledger would
-- read a regression that never happened. Rewritten to the writer's commit and
-- the second the log names (its ms are not recorded); `recent` re-sorted newest
-- first, and `last_seen_at` / `last_commit` re-derived from its new head.
-- Idempotent: matches only the wrong entry, so a second run (or a fork without
-- the row) changes nothing.
WITH fixed AS (
  SELECT r.id, (
    SELECT jsonb_agg(e ORDER BY (e->>'at')::bigint DESC)
    FROM (
      SELECT CASE
        WHEN (o->>'at')::bigint = 1794159155901
          AND o->>'commit' = 'dcc70defd9f46f595b620a8bea94bebc783ee9b0'
        THEN o || '{"at": 1794158465000, "commit": "9b06a6dcc5cd2dbd8cd4015b435527ec9c9d9ceb"}'::jsonb
        ELSE o
      END AS e
      FROM jsonb_array_elements(r.recent) o
    ) s
  ) AS recent
  FROM "reports" r
  WHERE r.id = 'report-1793823761-0xqf83'
    AND r.recent @> '[{"at": 1794159155901, "commit": "dcc70defd9f46f595b620a8bea94bebc783ee9b0"}]'::jsonb
)
UPDATE "reports" r SET
  "recent" = f.recent,
  "last_seen_at" = to_timestamp(((f.recent->0->>'at')::bigint) / 1000.0),
  "last_commit" = f.recent->0->>'commit'
FROM fixed f
WHERE r.id = f.id;
