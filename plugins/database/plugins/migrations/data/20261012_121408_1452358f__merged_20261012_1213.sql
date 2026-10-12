-- singularity:phase expand
CREATE TABLE IF NOT EXISTS "place_tags" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"parent_id" text,
	"color" text,
	"icon" text,
	"google_types" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"rank" integer DEFAULT 0 NOT NULL,
	"role" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE IF NOT EXISTS "places" (
	"id" text PRIMARY KEY NOT NULL,
	"google_place_id" text NOT NULL,
	"name" text NOT NULL,
	"address" text NOT NULL,
	"location" jsonb NOT NULL,
	"primary_type" text,
	"types" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"maps_url" text,
	"icon" text,
	"note" text DEFAULT '' NOT NULL,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"auto_tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
-- singularity:phase contract
CREATE UNIQUE INDEX IF NOT EXISTS "place_tags_role_idx" ON "place_tags" USING btree ("role") WHERE "place_tags"."role" IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "places_google_place_id_idx" ON "places" USING btree ("google_place_id");
-- singularity:claims
