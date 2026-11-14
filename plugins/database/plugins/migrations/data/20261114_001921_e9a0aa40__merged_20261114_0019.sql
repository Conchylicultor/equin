-- singularity:snapshot id=ee056957-03b9-4e18-89ad-09543c3640d9 parents=fd12927c-7593-4eea-9669-c0bd9c2331cb
-- singularity:supersedes 38148ccf
-- singularity:phase expand
CREATE TABLE "supervisorRoles_backlogArrived_triggers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_name" text NOT NULL,
	"job_with" jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"one_shot" boolean DEFAULT true NOT NULL,
	"declared" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
-- singularity:phase contract
-- singularity:claims
