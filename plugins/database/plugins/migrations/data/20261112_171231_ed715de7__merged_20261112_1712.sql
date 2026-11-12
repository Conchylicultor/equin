-- singularity:snapshot id=44a832ac-b99a-44a4-a5ed-f6c08822f2d3 parents=40b6e72f-b112-46cf-a370-f3c78ec73110
-- singularity:supersedes 16dbcef9
-- singularity:phase expand
CREATE TABLE "site_mirror_replicas" (
	"replica_id" text PRIMARY KEY NOT NULL,
	"deployment_id" text NOT NULL,
	"set_id" text NOT NULL,
	"requested_at" timestamp with time zone,
	"run_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "site_mirror_replicas_deployment_id_set_id_unique" UNIQUE("deployment_id","set_id")
);
-- singularity:phase contract
ALTER TABLE "site_mirror_replicas" ADD CONSTRAINT "site_mirror_replicas_replica_id_table_mirror_replicas_id_fk" FOREIGN KEY ("replica_id") REFERENCES "public"."table_mirror_replicas"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "site_mirror_replicas" ADD CONSTRAINT "site_mirror_replicas_deployment_id_deploy_deployments_id_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."deploy_deployments"("id") ON DELETE cascade ON UPDATE cascade;
-- singularity:claims
