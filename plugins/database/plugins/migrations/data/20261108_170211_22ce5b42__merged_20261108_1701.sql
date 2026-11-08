-- singularity:snapshot id=9f401d92-b693-427e-a038-0aa7ace678e0 parents=3eae9304-169b-4ba5-9cd0-7179ea9f7118
-- singularity:supersedes 67bba9de
-- singularity:supersedes 67bba9de <- b39b80e9
-- singularity:supersedes b39b80e9 <- 5542c0cc
-- singularity:phase expand
CREATE TABLE "report_fixes" (
	"report_id" text NOT NULL,
	"commit" text NOT NULL,
	"landed_at" timestamp with time zone NOT NULL,
	"deployed_at" timestamp with time zone,
	"regressed_at" timestamp with time zone,
	"regressed_commit" text,
	CONSTRAINT "report_fixes_report_id_commit_pk" PRIMARY KEY("report_id","commit")
);
ALTER TABLE "reports" ADD COLUMN "last_commit" text;
ALTER TABLE "reports" ADD COLUMN "fix_state" text DEFAULT 'open' NOT NULL;
ALTER TABLE "reports" ADD COLUMN "fix_commit" text;
ALTER TABLE "reports" ADD COLUMN "fix_state_at" timestamp with time zone;
ALTER TABLE "notifications" ADD COLUMN "state" jsonb;
CREATE INDEX "report_fixes_landed_idx" ON "report_fixes" USING btree ("landed_at");
CREATE INDEX "reports_fix_state_idx" ON "reports" USING btree ("fix_state");
-- singularity:phase contract
ALTER TABLE "report_fixes" ADD CONSTRAINT "report_fixes_report_id_reports_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."reports"("id") ON DELETE cascade ON UPDATE cascade;
-- singularity:claims
