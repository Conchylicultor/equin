-- Custom SQL migration file, put your code below! --
-- migration: 20261105_035410__reports_stale_origin_backfill --
-- reports.stale_origin is new: until now staleness was re-derived against the
-- server's CURRENT graph, and the boot noise reconcile wrote that judgement
-- into `noise`. What a row's record-time staleness was cannot be recovered, so
-- keep every row's classification as it stands: a muted row that carries a
-- bundle id, is about the page (`live-state-wedge` is about the server) and is
-- not explained by another rule (resize-observer) keeps staleness as the
-- reason it is muted. Idempotent (re-run by the deferred contract).
UPDATE "reports" SET "stale_origin" = true
WHERE "noise"
  AND "last_build_id" IS NOT NULL
  AND "source" <> 'live-state-wedge'
  AND lower("message") NOT LIKE '%resizeobserver%'
  AND lower(coalesce("data"->>'errorType', '')) NOT LIKE '%resizeobserver%'
  AND NOT "stale_origin";
