-- singularity:snapshot id=dca84999-6b9e-4696-9508-524f8eef6055 parents=d85ac621-8f7e-4ff1-b8c2-0591df62f09a
-- singularity:supersedes eb3ffd10
-- singularity:supersedes eb3ffd10 <- 4e288cfa
-- singularity:supersedes 4e288cfa <- 1c5965bf
-- singularity:supersedes 1c5965bf <- 58bc9bed
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
