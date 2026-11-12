-- singularity:snapshot id=53e1d179-c084-4023-b5c5-1036f6b0e077 parents=5e709931-62cf-4485-8d0d-7e7374f6badc
-- singularity:supersedes 77c36d5e
-- singularity:phase expand
CREATE TABLE "warmup_code_stamps" (
	"name" text PRIMARY KEY NOT NULL,
	"code_digest" text NOT NULL,
	"derived_at" timestamp with time zone DEFAULT now() NOT NULL
);
-- singularity:phase contract
-- singularity:claims
