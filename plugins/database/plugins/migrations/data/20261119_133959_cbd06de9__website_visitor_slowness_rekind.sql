-- Custom SQL migration file, put your code below! --
-- migration: 20261119_133959__website_visitor_slowness_rekind --
-- A website visitor's slowness is imported as `website-visitor-slowness`
-- (category slow-op) from now on, chosen by the site kind's own category.
-- Rows imported before as `website-visitor-error` keep their kind on a
-- recurrence (the upsert never rewrites `kind`), so the slow ones are
-- re-kinded here, in place: their ids — and so the fix ledger's claims on
-- them — carry over. The site kinds whose category is slow-op as of this
-- change (main-thread-stall, slow-interaction, render-loop — reports/*;
-- slow-page-load — site-reports/channel/slow-load).
-- Idempotent: only rows still of the old kind are touched.
UPDATE "reports" SET "kind" = 'website-visitor-slowness'
WHERE "kind" = 'website-visitor-error'
  AND "data"->>'siteKind' IN ('main-thread-stall', 'slow-interaction', 'render-loop', 'slow-page-load');
