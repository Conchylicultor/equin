-- singularity:phase expand
ALTER TABLE "analytics_daily" ADD COLUMN "returning_visits" integer DEFAULT 0 NOT NULL;
ALTER TABLE "analytics_visits" ADD COLUMN "returning" boolean DEFAULT false NOT NULL;
-- singularity:phase contract
-- singularity:claims
-- 20261020_193640__analytics_returning_backfill
