-- singularity:snapshot id=deeec945-0891-4d25-b5a1-dcfdd510a805 parents=5e5de393-5537-46c3-ad6a-ac76c52ba1f4
-- singularity:phase expand
CREATE TABLE "deploy_deployments_ext_box_link" (
	"parent_id" text PRIMARY KEY NOT NULL,
	"state" jsonb NOT NULL,
	"since" timestamp with time zone NOT NULL,
	"last_heard_at" timestamp with time zone,
	"last_beat" jsonb,
	"last_error" text,
	"hello" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE "deploy_deployments_ext_messages_seen" (
	"parent_id" text PRIMARY KEY NOT NULL,
	"seen_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX "analytics_visits_last_at_idx" ON "analytics_visits" USING btree ("last_at");
-- singularity:phase contract
ALTER TABLE "deploy_deployments_ext_box_link" ADD CONSTRAINT "deploy_deployments_ext_box_link_parent_id_deploy_deployments_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."deploy_deployments"("id") ON DELETE cascade ON UPDATE cascade;
ALTER TABLE "deploy_deployments_ext_messages_seen" ADD CONSTRAINT "deploy_deployments_ext_messages_seen_parent_id_deploy_deployments_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."deploy_deployments"("id") ON DELETE cascade ON UPDATE cascade;
-- singularity:claims
