-- singularity:snapshot id=9099812d-e204-46df-816c-9bb3f6b1a628 parents=8592c5a3-da05-437d-8a9b-25b55163fb9a
-- singularity:supersedes 5eca6228
-- singularity:phase expand
ALTER TABLE "claude_transcript_scans" ADD COLUMN "owner" text;
ALTER TABLE "claude_transcript_scans" ADD COLUMN "owner_tracked" boolean DEFAULT false NOT NULL;
-- singularity:phase contract
-- singularity:claims
