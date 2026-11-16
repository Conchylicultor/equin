-- singularity:snapshot id=5ec49773-1549-4890-a802-186c3cd2f3b4 parents=e68274be-e2c1-4305-80af-ad2c41fde2fc
-- singularity:phase expand
CREATE TABLE "claude_transcript_scans" (
	"path" text PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"kind" text NOT NULL,
	"offset" bigint NOT NULL,
	"tail_hashes" jsonb NOT NULL
);
CREATE INDEX "claude_transcript_scans_source_idx" ON "claude_transcript_scans" USING btree ("source");
-- singularity:phase contract
-- singularity:claims
