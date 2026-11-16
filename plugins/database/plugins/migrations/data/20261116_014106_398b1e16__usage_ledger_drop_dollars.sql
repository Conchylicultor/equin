-- singularity:snapshot id=a872fe72-7c6f-42db-aae7-37e8c160070d parents=99f10212-27e0-448e-b553-160e6769014e
-- singularity:phase expand
CREATE TABLE "claude_usage_import_accounts" (
	"source" text NOT NULL,
	"hour" timestamp with time zone NOT NULL,
	"account_id" text NOT NULL,
	CONSTRAINT "claude_usage_import_accounts_source_hour_pk" PRIMARY KEY("source","hour")
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
CREATE INDEX "claude_spend_sources_cost_idx" ON "claude_spend_sources" USING btree ("cost_usd");
-- singularity:phase contract
DROP TABLE "claude_spend_hours" CASCADE;
ALTER TABLE "conversation_usage_files" DROP COLUMN "cost_usd";
ALTER TABLE "conversation_usage_files" DROP COLUMN "unpriced_models";
-- singularity:claims
-- 20261116_013956__usage_ledger_legacy_carryover
