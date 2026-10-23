-- singularity:snapshot id=7128f479-156e-4d0e-8e5f-c9da66918485 parents=9fe1ee25-1a1d-4559-a3b4-b6d00a9aa2fd
-- singularity:supersedes 9d383b09
-- singularity:phase expand
CREATE TABLE IF NOT EXISTS "hint_seen" (
	"hint_id" text PRIMARY KEY NOT NULL,
	"outcome" text,
	"seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
-- singularity:phase contract
-- singularity:claims
