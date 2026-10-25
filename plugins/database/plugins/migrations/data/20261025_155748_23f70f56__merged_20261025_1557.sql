-- singularity:snapshot id=5219360d-92c5-495c-bcd1-027ba083997d parents=b92275ca-b08c-414c-ae94-6e12a85459b3
-- singularity:supersedes dfe0e9d2
-- singularity:phase expand
CREATE TABLE IF NOT EXISTS "deploy_secret_grants" (
	"deployment_id" text NOT NULL,
	"key" text NOT NULL,
	"value_fingerprint" text NOT NULL,
	"approved_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "deploy_secret_grants_deployment_id_key_pk" PRIMARY KEY("deployment_id","key")
);
CREATE TABLE IF NOT EXISTS "site_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"message" text NOT NULL,
	"reply_to" text NOT NULL,
	"host" text NOT NULL,
	"page" text NOT NULL,
	"ip_hash" text NOT NULL,
	"verdict" text NOT NULL,
	"spam_reason" text,
	"notify_state" text NOT NULL,
	"notify_error" text,
	"notified_at" timestamp with time zone
);
CREATE TABLE IF NOT EXISTS "site_messages_salt" (
	"name" text PRIMARY KEY NOT NULL,
	"salt" text NOT NULL
);
ALTER TABLE "deploy_runs" ADD COLUMN "approval_sections" text[] DEFAULT '{}' NOT NULL;
CREATE INDEX IF NOT EXISTS "site_messages_ip_hash_created_at_idx" ON "site_messages" USING btree ("ip_hash","created_at");
CREATE INDEX IF NOT EXISTS "site_messages_created_at_idx" ON "site_messages" USING btree ("created_at");
CREATE INDEX IF NOT EXISTS "site_messages_notify_state_idx" ON "site_messages" USING btree ("notify_state","notified_at");
-- singularity:phase contract
DO $$ BEGIN
 ALTER TABLE "deploy_secret_grants" ADD CONSTRAINT "deploy_secret_grants_deployment_id_deploy_deployments_id_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."deploy_deployments"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
-- singularity:claims
