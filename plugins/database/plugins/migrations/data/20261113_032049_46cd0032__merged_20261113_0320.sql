-- singularity:snapshot id=937783c1-de47-4ea8-826c-abd247264374 parents=775d7df0-5d4f-4f98-989e-1ffb44f91a08
-- singularity:supersedes 0ae0df68
-- singularity:supersedes 0ae0df68 <- e15a5a5d
-- singularity:phase expand
CREATE TABLE "analytics_consent_keys" (
	"key_hash" text PRIMARY KEY NOT NULL,
	"visitor_id" text NOT NULL,
	"last_day" date NOT NULL
);
-- singularity:phase contract
-- singularity:claims
