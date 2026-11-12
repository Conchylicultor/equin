-- singularity:snapshot id=65f150ac-9d35-4d00-911f-a1c20504afe1 parents=3ca8678a-4212-4db0-9e07-d6da29d50f30
-- singularity:supersedes b766b483
-- singularity:phase expand
CREATE TABLE "conversation_sections" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"rank" "rank_text" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
ALTER TABLE "conversations_ext_queue" ADD COLUMN "section" text;
-- singularity:phase contract
ALTER TABLE "conversations_ext_queue" DROP COLUMN "pinned";
-- singularity:claims
-- 20261112_001653__queue_section_from_pinned
