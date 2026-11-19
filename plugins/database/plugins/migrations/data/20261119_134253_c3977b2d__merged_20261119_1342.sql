-- singularity:snapshot id=a250919b-ea37-485d-b940-faec2f166d3e parents=5e5de393-5537-46c3-ad6a-ac76c52ba1f4
-- singularity:supersedes 6bc861e0
-- singularity:phase expand
CREATE TABLE "latency_ledger_client_minute" (
	"metric" text NOT NULL,
	"minute_start" timestamp with time zone NOT NULL,
	"client_kind" text NOT NULL,
	"scheme" smallint NOT NULL,
	"counts" integer[] NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	"sum_ms" double precision DEFAULT 0 NOT NULL,
	"max_ms" double precision DEFAULT 0 NOT NULL,
	"censored" integer DEFAULT 0 NOT NULL,
	"excluded" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "latency_ledger_client_minute_metric_minute_start_client_kind_pk" PRIMARY KEY("metric","minute_start","client_kind")
);
CREATE TABLE "latency_ledger_day" (
	"day" date NOT NULL,
	"metric" text NOT NULL,
	"client_kind" text NOT NULL,
	"minute_class" text NOT NULL,
	"scheme" smallint NOT NULL,
	"counts" integer[] NOT NULL,
	"count" integer NOT NULL,
	"max_ms" double precision NOT NULL,
	"censored" integer NOT NULL,
	"excluded" integer NOT NULL,
	CONSTRAINT "latency_ledger_day_day_metric_client_kind_minute_class_pk" PRIMARY KEY("day","metric","client_kind","minute_class")
);
CREATE TABLE "latency_ledger_host_day" (
	"day" date PRIMARY KEY NOT NULL,
	"calm_minutes" integer NOT NULL,
	"pressure_minutes" integer NOT NULL,
	"slept_minutes" integer NOT NULL,
	"unknown_minutes" integer NOT NULL,
	"rolled_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE "report_fingerprints_seen" (
	"fingerprint" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"first_seen_at" timestamp with time zone NOT NULL
);
CREATE TABLE "report_fix_days" (
	"day" date NOT NULL,
	"kind" text NOT NULL,
	"landed" integer DEFAULT 0 NOT NULL,
	"regressed" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "report_fix_days_day_kind_pk" PRIMARY KEY("day","kind")
);
CREATE TABLE "report_trend_days" (
	"day" date NOT NULL,
	"kind" text NOT NULL,
	"occurrences" integer NOT NULL,
	CONSTRAINT "report_trend_days_day_kind_pk" PRIMARY KEY("day","kind")
);
CREATE INDEX "latency_ledger_client_minute_start_idx" ON "latency_ledger_client_minute" USING btree ("minute_start");
CREATE INDEX "report_fingerprints_seen_first_idx" ON "report_fingerprints_seen" USING btree ("first_seen_at");
-- singularity:phase contract
-- singularity:claims
