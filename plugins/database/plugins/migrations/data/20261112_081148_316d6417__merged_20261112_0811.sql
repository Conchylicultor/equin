-- singularity:snapshot id=263b78bc-f0bc-461f-b657-2cff4a7c8182 parents=e5b9fa82-4691-469d-94e4-128f9b69d957
-- singularity:supersedes b9df23c5
-- singularity:phase expand
CREATE TABLE "op_rate_hour_calls" (
	"op" text NOT NULL,
	"hour_start" timestamp with time zone NOT NULL,
	"calls" integer NOT NULL,
	CONSTRAINT "op_rate_hour_calls_op_hour_start_pk" PRIMARY KEY("op","hour_start")
);
CREATE TABLE "op_rate_window_counts" (
	"op" text NOT NULL,
	"regime" text NOT NULL,
	"day_start" timestamp with time zone NOT NULL,
	"bucket" smallint NOT NULL,
	"windows" integer NOT NULL,
	CONSTRAINT "op_rate_window_counts_op_regime_day_start_bucket_pk" PRIMARY KEY("op","regime","day_start","bucket")
);
CREATE TABLE "op_rate_windows" (
	"regime" text NOT NULL,
	"hour_start" timestamp with time zone NOT NULL,
	"windows" integer NOT NULL,
	CONSTRAINT "op_rate_windows_regime_hour_start_pk" PRIMARY KEY("regime","hour_start")
);
CREATE INDEX "op_rate_hour_calls_hour_idx" ON "op_rate_hour_calls" USING btree ("hour_start");
CREATE INDEX "op_rate_window_counts_day_idx" ON "op_rate_window_counts" USING btree ("day_start");
-- singularity:phase contract
-- singularity:claims
