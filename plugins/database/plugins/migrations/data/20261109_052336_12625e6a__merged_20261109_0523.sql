-- singularity:snapshot id=ec004e9a-f993-422b-9ad4-0c1f7b14556a parents=c187774b-eb1e-4898-8d7f-02c93c1f1062
-- singularity:supersedes eee22264
-- singularity:phase expand
CREATE TABLE "stop_gate_reminders" (
	"conversation_id" text PRIMARY KEY NOT NULL,
	"turn_id" text NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL
);
-- singularity:phase contract
ALTER TABLE "stop_gate_reminders" ADD CONSTRAINT "stop_gate_reminders_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;
-- singularity:claims
