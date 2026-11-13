-- singularity:snapshot id=7b0b4dad-ff2a-46d5-b3dc-fff8a7b0e7e3 parents=775d7df0-5d4f-4f98-989e-1ffb44f91a08
-- singularity:supersedes e15a5a5d
-- singularity:phase expand
CREATE TABLE "analytics_consent_keys" (
	"key_hash" text PRIMARY KEY NOT NULL,
	"visitor_id" text NOT NULL,
	"last_day" date NOT NULL
);
-- singularity:phase contract
-- singularity:claims
