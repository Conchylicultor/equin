-- singularity:snapshot id=4ee37412-44b1-4161-9867-b0103bd0c18f parents=493325f8-8282-437b-94df-4d473c50c8a3
-- singularity:supersedes 27cb429b
-- singularity:supersedes 27cb429b <- 55462ad0
-- singularity:supersedes 55462ad0 <- e835fca4
-- singularity:phase expand
CREATE TABLE IF NOT EXISTS "tasks_autoStartArmed_triggers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_name" text NOT NULL,
	"job_with" jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"one_shot" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
-- singularity:phase contract
-- singularity:claims
