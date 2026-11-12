-- singularity:snapshot id=587f6c3b-2c9d-414e-863c-4d5994eaa236 parents=44a832ac-b99a-44a4-a5ed-f6c08822f2d3
-- singularity:supersedes a0d9c97d
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
