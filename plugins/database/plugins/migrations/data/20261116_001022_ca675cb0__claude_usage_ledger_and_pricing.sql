-- singularity:snapshot id=e68274be-e2c1-4305-80af-ad2c41fde2fc parents=51609897-0580-4619-b10f-7352f385f768
-- singularity:phase expand
CREATE TABLE "claude_model_rates" (
	"version_id" text NOT NULL,
	"model" text NOT NULL,
	"speed" text NOT NULL,
	"input_below" double precision NOT NULL,
	"input_above" double precision NOT NULL,
	"output_below" double precision NOT NULL,
	"output_above" double precision NOT NULL,
	"cache_read_below" double precision NOT NULL,
	"cache_read_above" double precision NOT NULL,
	"cache_create_5m_below" double precision NOT NULL,
	"cache_create_5m_above" double precision NOT NULL,
	"cache_create_1h_below" double precision NOT NULL,
	"cache_create_1h_above" double precision NOT NULL,
	CONSTRAINT "claude_model_rates_version_id_model_speed_pk" PRIMARY KEY("version_id","model","speed")
);
CREATE TABLE "claude_price_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"effective_from" timestamp with time zone NOT NULL,
	"source" text NOT NULL,
	"models" jsonb NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE "claude_usage_hours" (
	"account_id" text NOT NULL,
	"hour" timestamp with time zone NOT NULL,
	"source" text NOT NULL,
	"model" text NOT NULL,
	"speed" text NOT NULL,
	"input_below" bigint DEFAULT 0 NOT NULL,
	"input_above" bigint DEFAULT 0 NOT NULL,
	"output_below" bigint DEFAULT 0 NOT NULL,
	"output_above" bigint DEFAULT 0 NOT NULL,
	"cache_read_below" bigint DEFAULT 0 NOT NULL,
	"cache_read_above" bigint DEFAULT 0 NOT NULL,
	"cache_create_5m_below" bigint DEFAULT 0 NOT NULL,
	"cache_create_5m_above" bigint DEFAULT 0 NOT NULL,
	"cache_create_1h_below" bigint DEFAULT 0 NOT NULL,
	"cache_create_1h_above" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "claude_usage_hours_account_id_hour_source_model_speed_pk" PRIMARY KEY("account_id","hour","source","model","speed")
);
CREATE TABLE "claude_usage_sources" (
	"source" text PRIMARY KEY NOT NULL,
	"project_dir" text,
	"is_repo" boolean DEFAULT false NOT NULL,
	"title" text
);
CREATE INDEX "claude_usage_hours_hour_idx" ON "claude_usage_hours" USING btree ("hour");
CREATE INDEX "claude_usage_hours_source_idx" ON "claude_usage_hours" USING btree ("source");
-- singularity:phase contract
ALTER TABLE "claude_model_rates" ADD CONSTRAINT "claude_model_rates_version_id_claude_price_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."claude_price_versions"("id") ON DELETE cascade ON UPDATE no action;
-- singularity:claims
