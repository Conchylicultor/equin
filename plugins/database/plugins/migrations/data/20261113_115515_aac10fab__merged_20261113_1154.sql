-- singularity:snapshot id=fd12927c-7593-4eea-9669-c0bd9c2331cb parents=ea23997c-6529-4f14-9c75-f504e197bf19
-- singularity:supersedes 75d74a44
-- singularity:phase expand
CREATE TABLE "supervisor_roles" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"icon" text,
	"icon_by_user" boolean DEFAULT false NOT NULL,
	"listed" boolean DEFAULT true NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"prompt" text DEFAULT '' NOT NULL,
	"fallback" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE "tasks_ext_supervisor" (
	"parent_id" text PRIMARY KEY NOT NULL,
	"supervisor" text NOT NULL,
	"filed_from_task_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE "supervisorRoles_iconStale_triggers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_name" text NOT NULL,
	"job_with" jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"one_shot" boolean DEFAULT true NOT NULL,
	"declared" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
-- singularity:phase contract
ALTER TABLE "tasks_ext_supervisor" ADD CONSTRAINT "tasks_ext_supervisor_parent_id_tasks_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE cascade;
ALTER TABLE "tasks_ext_supervisor" ADD CONSTRAINT "tasks_ext_supervisor_supervisor_supervisor_roles_id_fk" FOREIGN KEY ("supervisor") REFERENCES "public"."supervisor_roles"("id") ON DELETE restrict ON UPDATE cascade;
CREATE UNIQUE INDEX "supervisor_roles_one_fallback_idx" ON "supervisor_roles" USING btree ("fallback") WHERE "supervisor_roles"."fallback";
CREATE UNIQUE INDEX "supervisor_roles_name_idx" ON "supervisor_roles" USING btree (lower("name"));
-- singularity:claims
