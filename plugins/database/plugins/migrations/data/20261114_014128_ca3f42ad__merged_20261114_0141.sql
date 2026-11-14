-- singularity:snapshot id=610c209d-89ce-45c5-af92-9f273c47ec87 parents=ee056957-03b9-4e18-89ad-09543c3640d9
-- singularity:supersedes cd0e0d35
-- singularity:phase expand
CREATE TABLE "supervisor_event_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"role_id" text NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	"events" integer NOT NULL,
	"lines" jsonb NOT NULL,
	"outcome" text NOT NULL,
	"task_id" text
);
CREATE TABLE "supervisor_event_pending" (
	"id" text PRIMARY KEY NOT NULL,
	"role_id" text NOT NULL,
	"stream_id" text NOT NULL,
	"key" text NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"ref" text,
	"count" integer DEFAULT 1 NOT NULL,
	"first_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE "supervisor_event_routes" (
	"stream_id" text PRIMARY KEY NOT NULL,
	"role_id" text NOT NULL,
	"kinds" jsonb
);
CREATE TABLE "supervisor_event_settings" (
	"role_id" text PRIMARY KEY NOT NULL,
	"gap_minutes" integer DEFAULT 10 NOT NULL,
	"idle" text DEFAULT 'drop' NOT NULL
);
CREATE INDEX "supervisor_event_messages_role_idx" ON "supervisor_event_messages" USING btree ("role_id","sent_at");
CREATE INDEX "supervisor_event_routes_role_idx" ON "supervisor_event_routes" USING btree ("role_id");
-- singularity:phase contract
ALTER TABLE "supervisor_event_messages" ADD CONSTRAINT "supervisor_event_messages_role_id_supervisor_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."supervisor_roles"("id") ON DELETE cascade ON UPDATE cascade;
ALTER TABLE "supervisor_event_pending" ADD CONSTRAINT "supervisor_event_pending_role_id_supervisor_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."supervisor_roles"("id") ON DELETE cascade ON UPDATE cascade;
ALTER TABLE "supervisor_event_routes" ADD CONSTRAINT "supervisor_event_routes_role_id_supervisor_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."supervisor_roles"("id") ON DELETE cascade ON UPDATE cascade;
ALTER TABLE "supervisor_event_settings" ADD CONSTRAINT "supervisor_event_settings_role_id_supervisor_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."supervisor_roles"("id") ON DELETE cascade ON UPDATE cascade;
CREATE UNIQUE INDEX "supervisor_event_pending_key_idx" ON "supervisor_event_pending" USING btree ("role_id","stream_id","key");
-- singularity:claims
