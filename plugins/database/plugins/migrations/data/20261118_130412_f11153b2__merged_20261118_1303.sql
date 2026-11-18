-- singularity:snapshot id=efd44da8-075d-4d7c-9598-83c148ffbc1d parents=611e13e0-08ff-4851-8432-6ea3d403187f
-- singularity:supersedes e2a709c3 a10d11ec
-- singularity:phase expand
CREATE TABLE "conversations_ext_launch" (
	"parent_id" text PRIMARY KEY NOT NULL,
	"attempt_id" text NOT NULL,
	"requested_at" timestamp with time zone NOT NULL,
	"marks" jsonb NOT NULL,
	"checkout_steps" jsonb NOT NULL,
	"checkout_source" text,
	"abandoned_at" timestamp with time zone,
	"agent_pid" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
-- singularity:phase contract
ALTER TABLE "conversations_ext_launch" ADD CONSTRAINT "conversations_ext_launch_parent_id_conversations_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE cascade;
-- singularity:claims
