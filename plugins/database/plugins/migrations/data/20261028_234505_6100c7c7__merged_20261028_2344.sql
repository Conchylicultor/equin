-- singularity:snapshot id=01ac77b3-0ac7-4676-8098-c8f14fb421cb parents=a2cae672-1f0c-4924-8dae-9a84acf30632
-- singularity:supersedes e71649d6
-- singularity:supersedes e71649d6 <- d4ba71bc
-- singularity:phase expand
CREATE TABLE "conversation_flags" (
	"id" text PRIMARY KEY DEFAULT 'cflag-' || gen_random_uuid() NOT NULL,
	"conversation_id" text NOT NULL,
	"task_id" text NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE "task_watches" (
	"id" text PRIMARY KEY DEFAULT 'watch-' || gen_random_uuid() NOT NULL,
	"task_id" text NOT NULL,
	"watcher" jsonb NOT NULL,
	"watcher_key" text NOT NULL,
	"watcher_conversation_id" text,
	"quiet" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone
);
CREATE TABLE "watch_inbox" (
	"id" text PRIMARY KEY DEFAULT 'wevt-' || gen_random_uuid() NOT NULL,
	"watch_id" text NOT NULL,
	"kind" text NOT NULL,
	"task_id" text NOT NULL,
	"actor_conversation_id" text,
	"summary" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"delivered_in_turn" text
);
CREATE TABLE "conversation_flagRaised_triggers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_name" text NOT NULL,
	"job_with" jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"one_shot" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"task_id" text
);
CREATE TABLE "outcomeReport_submitted_triggers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_name" text NOT NULL,
	"job_with" jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"one_shot" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"task_id" text
);
CREATE TABLE "tasks_created_triggers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_name" text NOT NULL,
	"job_with" jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"one_shot" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"folder_id" text
);
CREATE INDEX "conversation_flags_conversation_idx" ON "conversation_flags" USING btree ("conversation_id");
CREATE INDEX "task_watches_task_idx" ON "task_watches" USING btree ("task_id");
CREATE INDEX "task_watches_conversation_idx" ON "task_watches" USING btree ("watcher_conversation_id");
CREATE INDEX "watch_inbox_undelivered_idx" ON "watch_inbox" USING btree ("watch_id") WHERE "watch_inbox"."delivered_in_turn" IS NULL;
CREATE INDEX "conversation_flagRaised_triggers_taskId_idx" ON "conversation_flagRaised_triggers" USING btree ("task_id") WHERE enabled;
CREATE INDEX "outcomeReport_submitted_triggers_taskId_idx" ON "outcomeReport_submitted_triggers" USING btree ("task_id") WHERE enabled;
CREATE INDEX "tasks_created_triggers_folderId_idx" ON "tasks_created_triggers" USING btree ("folder_id") WHERE enabled;
-- singularity:phase contract
ALTER TABLE "conversation_flags" ADD CONSTRAINT "conversation_flags_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "conversation_flags" ADD CONSTRAINT "conversation_flags_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "task_watches" ADD CONSTRAINT "task_watches_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "task_watches" ADD CONSTRAINT "task_watches_watcher_conversation_id_conversations_id_fk" FOREIGN KEY ("watcher_conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "watch_inbox" ADD CONSTRAINT "watch_inbox_watch_id_task_watches_id_fk" FOREIGN KEY ("watch_id") REFERENCES "public"."task_watches"("id") ON DELETE cascade ON UPDATE cascade;
CREATE UNIQUE INDEX "task_watches_live_uq" ON "task_watches" USING btree ("task_id","watcher_key") WHERE "task_watches"."ended_at" IS NULL;
-- singularity:claims
