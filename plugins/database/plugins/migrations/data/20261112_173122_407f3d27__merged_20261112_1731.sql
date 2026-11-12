-- singularity:snapshot id=d6e0e122-808b-43d5-8ec7-04fb4f4196f8 parents=4d2e1c3b-969f-4f1e-8cf9-45d15362d7d5
-- singularity:supersedes a0efedfd
-- singularity:supersedes a0efedfd <- a0d9c97d
-- singularity:supersedes a0d9c97d <- a6036170
-- singularity:phase expand
CREATE TABLE "conversations_ext_system_prompt" (
	"parent_id" text PRIMARY KEY NOT NULL,
	"sections" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
-- singularity:phase contract
ALTER TABLE "conversations_ext_system_prompt" ADD CONSTRAINT "conversations_ext_system_prompt_parent_id_conversations_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE cascade;
-- singularity:claims
