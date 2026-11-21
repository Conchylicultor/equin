-- singularity:snapshot id=e39c0591-50a9-407a-9ee2-a1f7b8668768 parents=d795b926-da39-4ba5-8240-f52e065ea7ad
-- singularity:supersedes db618468
-- singularity:phase expand
CREATE TABLE "conversation_runHandedOver_triggers" (
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
