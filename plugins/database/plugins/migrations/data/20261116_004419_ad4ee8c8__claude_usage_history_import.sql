-- singularity:snapshot id=29fb1c76-f5d0-4102-8bd7-5d4757ebfdd3 parents=5ec49773-1549-4890-a802-186c3cd2f3b4
-- singularity:phase expand
CREATE TABLE "claude_usage_history_imports" (
	"name" text PRIMARY KEY NOT NULL,
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL,
	"summary" jsonb NOT NULL
);
ALTER TABLE "claude_usage_hours" DROP CONSTRAINT "claude_usage_hours_account_id_hour_source_model_speed_pk";
ALTER TABLE "claude_usage_hours" ADD COLUMN "origin" text DEFAULT 'counted' NOT NULL;
-- singularity:phase contract
ALTER TABLE "claude_usage_hours" ADD CONSTRAINT "claude_usage_hours_account_id_hour_source_model_speed_origin_pk" PRIMARY KEY("account_id","hour","source","model","speed","origin");
-- singularity:claims
