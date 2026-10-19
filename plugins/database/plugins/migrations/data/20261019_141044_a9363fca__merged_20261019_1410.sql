-- singularity:phase expand
CREATE TABLE IF NOT EXISTS "conversations_ext_spawn_failure" (
	"parent_id" text PRIMARY KEY NOT NULL,
	"step" text NOT NULL,
	"message" text NOT NULL,
	"failed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
-- singularity:phase contract
DO $$ BEGIN
 ALTER TABLE "conversations_ext_spawn_failure" ADD CONSTRAINT "conversations_ext_spawn_failure_parent_id_conversations_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE cascade;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
-- singularity:claims
