-- singularity:phase expand
CREATE TABLE IF NOT EXISTS "sonata_songs_ext_swing" (
	"parent_id" text PRIMARY KEY NOT NULL,
	"swung" boolean DEFAULT false NOT NULL,
	"unit" integer DEFAULT 8 NOT NULL,
	"ratio" double precision DEFAULT 2 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
-- singularity:phase contract
DO $$ BEGIN
 ALTER TABLE "sonata_songs_ext_swing" ADD CONSTRAINT "sonata_songs_ext_swing_parent_id_sonata_songs_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."sonata_songs"("id") ON DELETE cascade ON UPDATE cascade;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
-- singularity:claims
