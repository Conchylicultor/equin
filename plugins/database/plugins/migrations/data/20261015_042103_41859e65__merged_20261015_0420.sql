-- singularity:phase expand
ALTER TABLE "places" ALTER COLUMN "google_place_id" DROP NOT NULL;
ALTER TABLE "place_tags" ADD COLUMN "child_colors" text;
ALTER TABLE "places" ADD COLUMN "title" text;
ALTER TABLE "places" ADD COLUMN "business_status" text;
-- singularity:phase contract
ALTER TABLE "places" ADD CONSTRAINT "places_custom_no_google" CHECK (google_place_id IS NOT NULL OR (title IS NULL AND primary_type IS NULL AND maps_url IS NULL AND business_status IS NULL AND types = '[]'::jsonb));
-- singularity:claims
-- 20261013_172250__places_roles_been_want
