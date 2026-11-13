-- singularity:snapshot id=72e30f20-661f-4b9a-ba8b-be89e06cdbb8 parents=5dd8b139-d7b3-46b5-a5c1-6f619e9e4df7
-- singularity:supersedes a8d05fcf
-- singularity:phase expand
CREATE TABLE "conversation_usage_account_days" (
	"account_id" text NOT NULL,
	"date" text NOT NULL,
	"cost_usd" double precision NOT NULL,
	CONSTRAINT "conversation_usage_account_days_account_id_date_pk" PRIMARY KEY("account_id","date")
);
-- singularity:phase contract
-- singularity:claims
