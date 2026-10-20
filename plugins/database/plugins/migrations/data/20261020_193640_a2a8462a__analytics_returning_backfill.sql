-- Custom SQL migration file, put your code below! --
-- migration: 20261020_193640__analytics_returning_backfill --
-- Visits recorded before `returning` existed: a visit is a return when its
-- visitor had an earlier one. Idempotent: it only flips `false` rows.
UPDATE "analytics_visits" v
SET "returning" = true
WHERE NOT v."returning"
  AND EXISTS (
    SELECT 1 FROM "analytics_visits" p
    WHERE p."visitor_id" = v."visitor_id" AND p."started_at" < v."started_at"
  );
-- Daily totals summed before `returning_visits` existed count 0 returns. Drop
-- them for every day whose raw visits are still kept: the report reads those
-- days from raw rows until the nightly rollup re-sums them (it backfills any
-- day with visits but no totals). Days within a few days of the 90-day raw
-- window's edge are kept as they are, so the retention sweep never meets a
-- day the rollup has not re-summed yet; older days have no raw rows at all.
DELETE FROM "analytics_daily"
WHERE "day" IN (
  SELECT DISTINCT "day" FROM "analytics_visits"
  WHERE "day" > (now() AT TIME ZONE 'UTC')::date - 85
);
