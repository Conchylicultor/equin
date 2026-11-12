-- singularity:snapshot id=3ca8678a-4212-4db0-9e07-d6da29d50f30 parents=02d58d8b-b43b-41a2-90a4-406508e43580
-- singularity:supersedes cf5b5c2b
-- singularity:phase expand
CREATE TABLE "site_report_imports" (
	"deployment_id" text PRIMARY KEY NOT NULL,
	"watermark" timestamp with time zone,
	"last_run_at" timestamp with time zone NOT NULL,
	"last_outcome" text NOT NULL
);
-- singularity:phase contract
ALTER TABLE "site_report_imports" ADD CONSTRAINT "site_report_imports_deployment_id_deploy_deployments_id_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."deploy_deployments"("id") ON DELETE cascade ON UPDATE no action;
-- singularity:claims
