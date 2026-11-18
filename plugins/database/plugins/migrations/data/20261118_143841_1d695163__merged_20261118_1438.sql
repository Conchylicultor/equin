-- singularity:snapshot id=5e5de393-5537-46c3-ad6a-ac76c52ba1f4 parents=9fa186b0-9a2e-4edc-a9ba-ee37b1485dbd
-- singularity:supersedes 4863ec7e
-- singularity:phase expand
CREATE TABLE "worktree_checkoutProgress_triggers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_name" text NOT NULL,
	"job_with" jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"one_shot" boolean DEFAULT true NOT NULL,
	"declared" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"attempt_id" text
);
CREATE INDEX "worktree_checkoutProgress_triggers_attemptId_idx" ON "worktree_checkoutProgress_triggers" USING btree ("attempt_id") WHERE enabled;
-- singularity:phase contract
-- singularity:claims
