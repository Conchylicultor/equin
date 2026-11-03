-- singularity:snapshot id=649805cf-1a45-460d-8eaf-699ba6d30fa8 parents=abb0a4f2-74ab-45cb-a572-867943fc2c87
-- singularity:supersedes 86383e37 f8d6b104
-- singularity:phase expand
CREATE TABLE "conversation_mandate_notices" (
	"conversation_id" text PRIMARY KEY NOT NULL,
	"turn_id" text NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE "tasks_mandateChanged_triggers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_name" text NOT NULL,
	"job_with" jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"one_shot" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
-- singularity:phase contract
ALTER TABLE "conversation_mandate_notices" ADD CONSTRAINT "conversation_mandate_notices_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;
-- singularity:claims
