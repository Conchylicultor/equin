-- singularity:supersedes e69024bd
-- singularity:supersedes e69024bd <- c4164453
-- singularity:phase expand
CREATE TABLE IF NOT EXISTS "conversations_ext_places_ask" (
	"parent_id" text PRIMARY KEY NOT NULL,
	"candidates" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
-- singularity:phase contract
DO $$ BEGIN
 ALTER TABLE "conversations_ext_places_ask" ADD CONSTRAINT "conversations_ext_places_ask_parent_id_conversations_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE cascade;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
-- singularity:claims
