-- singularity:snapshot id=51609897-0580-4619-b10f-7352f385f768 parents=16dd63e5-05bc-47b9-b1c8-7de6ed74f439
-- singularity:supersedes 7384ae68
-- singularity:phase expand
CREATE TABLE "claude_spend_hours" (
	"account_id" text NOT NULL,
	"hour" timestamp with time zone NOT NULL,
	"source" text NOT NULL,
	"cost_usd" double precision NOT NULL,
	CONSTRAINT "claude_spend_hours_account_id_hour_source_pk" PRIMARY KEY("account_id","hour","source")
);
ALTER TABLE "claude_cli_calls" ADD COLUMN "cost_usd" double precision;
-- singularity:phase contract
DROP TABLE "conversation_usage_account_days" CASCADE;
-- singularity:claims
-- 20261115_113310__claude_spend_hours_backfill
