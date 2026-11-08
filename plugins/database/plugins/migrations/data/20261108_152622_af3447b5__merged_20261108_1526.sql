-- singularity:snapshot id=59f5fa0f-368d-4bae-953a-1830707e831d parents=60dec196-7ede-4019-b83e-532e4ffe7dbe
-- singularity:supersedes 3d173433
-- singularity:phase expand
CREATE TABLE "job_attempt_reports" (
	"job_id" text NOT NULL,
	"attempt" integer NOT NULL,
	"report_id" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"data" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "job_attempt_reports_job_id_attempt_pk" PRIMARY KEY("job_id","attempt")
);
-- singularity:phase contract
-- singularity:claims
