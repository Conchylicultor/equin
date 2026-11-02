-- singularity:snapshot id=409d9e32-4a9f-4e9c-99e7-e221f7422695 parents=18710111-d80a-4024-813c-2813d22ace91
-- singularity:supersedes 1c3fd9c8
-- singularity:phase expand
CREATE TABLE "claude_cli_call_horizon" (
	"id" text PRIMARY KEY NOT NULL,
	"total" integer NOT NULL,
	"oldest" timestamp with time zone
);
-- singularity:phase contract
-- singularity:claims
