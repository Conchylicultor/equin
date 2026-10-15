-- singularity:phase expand
CREATE TABLE IF NOT EXISTS "conversation_prompt_hooks" (
	"conversation_id" text PRIMARY KEY NOT NULL,
	"launched_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE IF NOT EXISTS "conversation_turns" (
	"id" text PRIMARY KEY NOT NULL,
	"conversation_id" text NOT NULL,
	"kind" text NOT NULL,
	"text" text NOT NULL,
	"typed_text" text NOT NULL,
	"state" text NOT NULL,
	"hookless" boolean DEFAULT false NOT NULL,
	"submitted_text" text,
	"extra_text" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);
CREATE INDEX IF NOT EXISTS "conversation_turns_conversation_idx" ON "conversation_turns" USING btree ("conversation_id","created_at");
CREATE INDEX IF NOT EXISTS "conversation_turns_updated_at_idx" ON "conversation_turns" USING btree ("updated_at");
-- singularity:phase contract
DROP TABLE "conversation_held_turns" CASCADE;
DO $$ BEGIN
 ALTER TABLE "conversation_prompt_hooks" ADD CONSTRAINT "conversation_prompt_hooks_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "conversation_turns" ADD CONSTRAINT "conversation_turns_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
-- singularity:claims
