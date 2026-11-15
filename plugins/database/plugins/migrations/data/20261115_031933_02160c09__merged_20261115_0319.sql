-- singularity:snapshot id=a640b086-08b4-4257-846a-b8e127006e39 parents=389fe9e6-5218-4950-b39e-267549d4167e
-- singularity:supersedes dadc88f8
-- singularity:phase expand
CREATE TABLE "op_rate_day_buckets" (
	"op" text NOT NULL,
	"regime" text NOT NULL,
	"day_start" timestamp with time zone NOT NULL,
	"windows" integer[] NOT NULL,
	CONSTRAINT "op_rate_day_buckets_op_regime_day_start_pk" PRIMARY KEY("op","regime","day_start")
);
CREATE TABLE "op_rate_day_hours" (
	"op" text NOT NULL,
	"day_start" timestamp with time zone NOT NULL,
	"calls" integer[] NOT NULL,
	CONSTRAINT "op_rate_day_hours_op_day_start_pk" PRIMARY KEY("op","day_start")
);
CREATE INDEX "op_rate_day_buckets_day_idx" ON "op_rate_day_buckets" USING btree ("day_start");
CREATE INDEX "op_rate_day_hours_day_idx" ON "op_rate_day_hours" USING btree ("day_start");
-- singularity:phase contract
DROP TABLE "op_rate_hour_calls" CASCADE;
DROP TABLE "op_rate_window_counts" CASCADE;
-- singularity:claims
-- 20261115_031307__op_rate_day_rows_backfill
