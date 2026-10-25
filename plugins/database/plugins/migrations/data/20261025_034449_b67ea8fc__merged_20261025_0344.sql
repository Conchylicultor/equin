-- singularity:snapshot id=50b13286-8c74-4cf7-be6d-b5d4e2f31062 parents=de4900c5-46ab-4a25-9228-bd763dfdb474
-- singularity:supersedes ed48e1e2
-- singularity:phase expand
DROP INDEX IF EXISTS "notifications_unread_badge_idx";
ALTER TABLE "notifications" ADD COLUMN "audience" text DEFAULT 'user' NOT NULL;
CREATE INDEX IF NOT EXISTS "notifications_unread_badge_idx" ON "notifications" USING btree ("variant","audience") WHERE "notifications"."dismissed" = false AND "notifications"."read" = false AND "notifications"."muted" = false;
-- singularity:phase contract
-- singularity:claims
-- 20261025_032701__notifications_audience_backfill
