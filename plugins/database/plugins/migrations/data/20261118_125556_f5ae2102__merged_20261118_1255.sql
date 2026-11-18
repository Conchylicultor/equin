-- singularity:snapshot id=611e13e0-08ff-4851-8432-6ea3d403187f parents=2cefce02-bbc5-4da0-b3a6-2070c7122962
-- singularity:supersedes 1a71e762
-- singularity:phase expand
CREATE TABLE "supervisorRoles_listingChanged_triggers" (
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
