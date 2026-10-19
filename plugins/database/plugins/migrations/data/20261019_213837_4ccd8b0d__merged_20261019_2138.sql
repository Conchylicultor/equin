-- singularity:phase expand
CREATE TABLE IF NOT EXISTS "tasks_ext_runtime" (
	"parent_id" text PRIMARY KEY NOT NULL,
	"runtime" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE IF NOT EXISTS "conversations_ext_sdk_agent" (
	"parent_id" text PRIMARY KEY NOT NULL,
	"worktree_path" text NOT NULL,
	"cursor_seq" integer NOT NULL,
	"session_id" text,
	"working" boolean NOT NULL,
	"status_at" timestamp with time zone,
	"cli_version" text,
	"agent_pid" integer,
	"open_request_id" text,
	"open_tool_use_id" text,
	"last_prompt_uuid" text,
	"last_prompt_text" text,
	"turn_replied" boolean NOT NULL,
	"last_assistant_uuid" text,
	"rewind_anchor_uuid" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
-- singularity:phase contract
DO $$ BEGIN
 ALTER TABLE "tasks_ext_runtime" ADD CONSTRAINT "tasks_ext_runtime_parent_id_tasks_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE cascade;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "conversations_ext_sdk_agent" ADD CONSTRAINT "conversations_ext_sdk_agent_parent_id_conversations_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE cascade;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
-- singularity:claims
