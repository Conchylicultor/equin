-- singularity:snapshot id=fd8e6d51-87e3-4406-bf01-dbfaf234adc1 parents=d1b7b216-f7ce-41e6-ada6-15b9d564aeb6
-- singularity:supersedes 95eaaa70
-- singularity:phase expand
CREATE TABLE "compaction_context_sends" (
	"conversation_id" text PRIMARY KEY NOT NULL,
	"context" text NOT NULL,
	"sent_at" timestamp with time zone NOT NULL
);
-- singularity:phase contract
-- singularity:claims
