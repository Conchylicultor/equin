-- singularity:snapshot id=99f10212-27e0-448e-b553-160e6769014e parents=29fb1c76-f5d0-4102-8bd7-5d4757ebfdd3
-- singularity:phase expand
CREATE TABLE "claude_account_spend_carryover" (
	"account_id" text NOT NULL,
	"day" date NOT NULL,
	"cost_usd" double precision NOT NULL,
	CONSTRAINT "claude_account_spend_carryover_account_id_day_pk" PRIMARY KEY("account_id","day")
);
-- singularity:phase contract
-- singularity:claims
