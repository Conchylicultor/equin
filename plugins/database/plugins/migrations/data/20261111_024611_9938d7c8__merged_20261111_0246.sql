-- singularity:snapshot id=67c18c9b-e327-4d46-8134-4b3b4dddb922 parents=e7a19f00-9c2a-4230-a842-9a231aaa0e1e
-- singularity:supersedes 822755c6
-- singularity:phase expand
CREATE TABLE "site_report_drops" (
	"window_started_at" timestamp with time zone NOT NULL,
	"reason" text NOT NULL,
	"count" integer NOT NULL,
	CONSTRAINT "site_report_drops_window_started_at_reason_pk" PRIMARY KEY("window_started_at","reason")
);
CREATE TABLE "site_reports" (
	"fingerprint" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"source" text NOT NULL,
	"message" text NOT NULL,
	"data" jsonb NOT NULL,
	"path" text NOT NULL,
	"build_id" text,
	"commit" text,
	"count" integer NOT NULL,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL
);
CREATE INDEX "site_reports_last_seen_at_idx" ON "site_reports" USING btree ("last_seen_at");
-- singularity:phase contract
-- singularity:claims
