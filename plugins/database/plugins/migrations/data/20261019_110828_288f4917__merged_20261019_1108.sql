-- singularity:phase expand
CREATE TABLE IF NOT EXISTS "google_maps_usage" (
	"usage_key" text PRIMARY KEY NOT NULL,
	"month" text NOT NULL,
	"sku" text NOT NULL,
	"calls" integer DEFAULT 0 NOT NULL,
	"last_called_at" timestamp with time zone DEFAULT now() NOT NULL
);
-- singularity:phase contract
-- singularity:claims
