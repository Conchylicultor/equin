-- singularity:snapshot id=45f8cba3-4d04-4d79-a017-a592b04a52c6 parents=a091aac2-c955-46f2-bc28-188916b4e66e
-- singularity:supersedes cd1b6781
-- singularity:phase expand
CREATE TABLE "conversation_compactions" (
	"conversation_id" text PRIMARY KEY NOT NULL,
	"keep" text NOT NULL,
	"next" text NOT NULL,
	"compact_turn_id" text NOT NULL,
	"next_turn_id" text NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL
);
-- singularity:phase contract
ALTER TABLE "conversation_compactions" ADD CONSTRAINT "conversation_compactions_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;
-- singularity:claims
