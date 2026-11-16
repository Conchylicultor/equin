-- singularity:snapshot id=4e353d1f-5e60-4c93-8add-3036440d6357 parents=51609897-0580-4619-b10f-7352f385f768
-- singularity:supersedes ca675cb0 90d12878 ad4ee8c8 c11b65a1 398b1e16
-- singularity:phase expand
CREATE TABLE "claude_account_spend_carryover" (
	"account_id" text NOT NULL,
	"day" date NOT NULL,
	"cost_usd" double precision NOT NULL,
	CONSTRAINT "claude_account_spend_carryover_account_id_day_pk" PRIMARY KEY("account_id","day")
);
CREATE TABLE "claude_transcript_scans" (
	"path" text PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"kind" text NOT NULL,
	"offset" bigint NOT NULL,
	"tail_hashes" jsonb NOT NULL
);
CREATE TABLE "claude_usage_history_imports" (
	"name" text PRIMARY KEY NOT NULL,
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL,
	"summary" jsonb NOT NULL
);
CREATE TABLE "claude_usage_import_accounts" (
	"source" text NOT NULL,
	"hour" timestamp with time zone NOT NULL,
	"account_id" text NOT NULL,
	CONSTRAINT "claude_usage_import_accounts_source_hour_pk" PRIMARY KEY("source","hour")
);
CREATE TABLE "claude_model_rates" (
	"version_id" text NOT NULL,
	"model" text NOT NULL,
	"speed" text NOT NULL,
	"input_below" double precision NOT NULL,
	"input_above" double precision NOT NULL,
	"output_below" double precision NOT NULL,
	"output_above" double precision NOT NULL,
	"cache_read_below" double precision NOT NULL,
	"cache_read_above" double precision NOT NULL,
	"cache_create_5m_below" double precision NOT NULL,
	"cache_create_5m_above" double precision NOT NULL,
	"cache_create_1h_below" double precision NOT NULL,
	"cache_create_1h_above" double precision NOT NULL,
	CONSTRAINT "claude_model_rates_version_id_model_speed_pk" PRIMARY KEY("version_id","model","speed")
);
CREATE TABLE "claude_price_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"effective_from" timestamp with time zone NOT NULL,
	"source" text NOT NULL,
	"models" jsonb NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE "claude_usage_hours" (
	"account_id" text NOT NULL,
	"hour" timestamp with time zone NOT NULL,
	"source" text NOT NULL,
	"model" text NOT NULL,
	"speed" text NOT NULL,
	"origin" text DEFAULT 'counted' NOT NULL,
	"input_below" bigint DEFAULT 0 NOT NULL,
	"input_above" bigint DEFAULT 0 NOT NULL,
	"output_below" bigint DEFAULT 0 NOT NULL,
	"output_above" bigint DEFAULT 0 NOT NULL,
	"cache_read_below" bigint DEFAULT 0 NOT NULL,
	"cache_read_above" bigint DEFAULT 0 NOT NULL,
	"cache_create_5m_below" bigint DEFAULT 0 NOT NULL,
	"cache_create_5m_above" bigint DEFAULT 0 NOT NULL,
	"cache_create_1h_below" bigint DEFAULT 0 NOT NULL,
	"cache_create_1h_above" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "claude_usage_hours_account_id_hour_source_model_speed_origin_pk" PRIMARY KEY("account_id","hour","source","model","speed","origin")
);
CREATE TABLE "claude_usage_sources" (
	"source" text PRIMARY KEY NOT NULL,
	"project_dir" text,
	"is_repo" boolean DEFAULT false NOT NULL,
	"title" text
);
CREATE TABLE "claude_spend_days" (
	"day" date NOT NULL,
	"model" text NOT NULL,
	"is_repo" boolean NOT NULL,
	"cost_usd" double precision DEFAULT 0 NOT NULL,
	"input" bigint DEFAULT 0 NOT NULL,
	"output" bigint DEFAULT 0 NOT NULL,
	"cache_creation" bigint DEFAULT 0 NOT NULL,
	"cache_read" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "claude_spend_days_day_model_is_repo_pk" PRIMARY KEY("day","model","is_repo")
);
CREATE TABLE "claude_spend_sources" (
	"source" text PRIMARY KEY NOT NULL,
	"cost_usd" double precision DEFAULT 0 NOT NULL,
	"input" bigint DEFAULT 0 NOT NULL,
	"output" bigint DEFAULT 0 NOT NULL,
	"cache_creation" bigint DEFAULT 0 NOT NULL,
	"cache_read" bigint DEFAULT 0 NOT NULL,
	"last_hour" timestamp with time zone NOT NULL,
	"models" text[] NOT NULL
);
CREATE INDEX "claude_transcript_scans_source_idx" ON "claude_transcript_scans" USING btree ("source");
CREATE INDEX "claude_usage_hours_hour_idx" ON "claude_usage_hours" USING btree ("hour");
CREATE INDEX "claude_usage_hours_source_idx" ON "claude_usage_hours" USING btree ("source");
CREATE INDEX "claude_spend_sources_cost_idx" ON "claude_spend_sources" USING btree ("cost_usd");
-- singularity:phase contract
DROP TABLE "claude_spend_hours" CASCADE;
ALTER TABLE "claude_model_rates" ADD CONSTRAINT "claude_model_rates_version_id_claude_price_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."claude_price_versions"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "conversation_usage_files" DROP COLUMN "cost_usd";
ALTER TABLE "conversation_usage_files" DROP COLUMN "unpriced_models";
-- singularity:claims
-- 20261116_013956__usage_ledger_legacy_carryover
-- 20261116_020330__usage_files_one_row_per_transcript
