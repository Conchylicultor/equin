-- singularity:snapshot id=25f13bab-3212-49ba-b020-e004beac078b parents=9fe1ee25-1a1d-4559-a3b4-b6d00a9aa2fd
-- singularity:supersedes 06043e35
-- singularity:supersedes 06043e35 <- 9d383b09
-- singularity:phase expand
CREATE TABLE IF NOT EXISTS "hint_seen" (
	"hint_id" text PRIMARY KEY NOT NULL,
	"outcome" text,
	"seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
-- singularity:phase contract
-- singularity:claims
