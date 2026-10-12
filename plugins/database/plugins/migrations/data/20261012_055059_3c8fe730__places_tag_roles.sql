-- singularity:phase expand
ALTER TABLE "place_tags" ADD COLUMN "role" text;
-- singularity:phase contract
CREATE UNIQUE INDEX IF NOT EXISTS "place_tags_role_idx" ON "place_tags" USING btree ("role") WHERE "place_tags"."role" IS NOT NULL;
-- singularity:claims
