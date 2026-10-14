-- singularity:phase expand
CREATE TABLE IF NOT EXISTS "sonata_songs_ext_transcription" (
	"parent_id" text PRIMARY KEY NOT NULL,
	"status" text NOT NULL,
	"input" jsonb NOT NULL,
	"task_id" text NOT NULL,
	"conversation_id" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE IF NOT EXISTS "attempt_deliveries" (
	"attempt_id" text PRIMARY KEY NOT NULL,
	"conversation_id" text NOT NULL,
	"summary" text NOT NULL,
	"delivered_at" timestamp with time zone DEFAULT now() NOT NULL
);
-- singularity:phase contract
DO $$ BEGIN
 ALTER TABLE "sonata_songs_ext_transcription" ADD CONSTRAINT "sonata_songs_ext_transcription_parent_id_sonata_songs_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."sonata_songs"("id") ON DELETE cascade ON UPDATE cascade;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "attempt_deliveries" ADD CONSTRAINT "attempt_deliveries_attempt_id_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."attempts"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
-- singularity:claims
