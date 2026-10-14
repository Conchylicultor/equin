-- singularity:phase expand
CREATE TABLE IF NOT EXISTS "slow_op_callers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"worktree" text NOT NULL,
	"operation_kind" text NOT NULL,
	"operation" text NOT NULL,
	"caller_kind" text NOT NULL,
	"caller_label" text NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	"total_ms" double precision DEFAULT 0 NOT NULL,
	"max_ms" double precision DEFAULT 0 NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "slow_op_callers_op_total_ms_idx" ON "slow_op_callers" USING btree ("operation_kind","operation","total_ms" DESC NULLS LAST,"id");
CREATE INDEX IF NOT EXISTS "slow_op_callers_last_seen_at_idx" ON "slow_op_callers" USING btree ("last_seen_at");
CREATE INDEX IF NOT EXISTS "slow_ops_total_ms_idx" ON "slow_ops" USING btree ("total_ms" DESC NULLS LAST,"id");
CREATE INDEX IF NOT EXISTS "slow_ops_last_seen_at_idx" ON "slow_ops" USING btree ("last_seen_at" DESC NULLS LAST,"id");
-- singularity:phase contract
CREATE UNIQUE INDEX IF NOT EXISTS "slow_op_callers_key_idx" ON "slow_op_callers" USING btree ("operation_kind","operation","worktree","caller_kind","caller_label");
-- singularity:claims
-- 20261013_154431__slow_op_callers_backfill
