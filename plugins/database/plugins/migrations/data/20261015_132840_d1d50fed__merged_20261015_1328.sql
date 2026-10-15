-- singularity:phase expand
ALTER TABLE "places" DROP CONSTRAINT "places_custom_no_google";
ALTER TABLE "places" ADD COLUMN "google_lost_at" timestamp with time zone;
-- singularity:phase contract
ALTER TABLE "places" ADD CONSTRAINT "places_custom_no_google" CHECK (google_place_id IS NOT NULL OR (title IS NULL AND primary_type IS NULL AND maps_url IS NULL AND business_status IS NULL AND google_lost_at IS NULL AND types = '[]'::jsonb));
-- singularity:claims
