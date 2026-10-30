-- singularity:snapshot id=9a7763a4-59ef-4505-8344-b5648e4e0471 parents=21e29e17-d798-48d9-a76a-9b6b861c067c
-- singularity:supersedes 8cbadbcc
-- singularity:phase expand
CREATE TABLE "tasks_ext_mandate" (
	"parent_id" text PRIMARY KEY NOT NULL,
	"mandate_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
ALTER TABLE "tasks" DROP CONSTRAINT "tasks_root_has_mandate";
ALTER TABLE "tasks" ADD COLUMN "mandate_ref" text;
-- singularity:phase contract
ALTER TABLE "tasks_ext_mandate" ADD CONSTRAINT "tasks_ext_mandate_parent_id_tasks_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE cascade;
ALTER TABLE "tasks" DROP COLUMN "mandate";
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_root_has_mandate" CHECK ("tasks"."folder_id" IS NOT NULL OR "tasks"."mandate_ref" IS NOT NULL);
-- singularity:claims
-- 20261030_110047__tasks_named_mandates_backfill
