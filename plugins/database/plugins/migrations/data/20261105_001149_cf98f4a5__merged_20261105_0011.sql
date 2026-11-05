-- singularity:snapshot id=90ccefb7-b8a0-47a9-9f52-2ae5f5f45c25 parents=457c6664-ccba-439b-abb4-6a4a0a5deffd
-- singularity:supersedes ad78445a
-- singularity:phase expand
CREATE TABLE "conversations_ext_context_usage" (
	"parent_id" text PRIMARY KEY NOT NULL,
	"usage" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
-- singularity:phase contract
ALTER TABLE "conversations_ext_context_usage" ADD CONSTRAINT "conversations_ext_context_usage_parent_id_conversations_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE cascade;
-- singularity:claims
