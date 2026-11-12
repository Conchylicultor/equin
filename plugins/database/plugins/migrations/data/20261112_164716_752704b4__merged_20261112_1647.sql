-- singularity:snapshot id=40b6e72f-b112-46cf-a370-f3c78ec73110 parents=04123b4d-3456-4a76-8426-348f2e954385
-- singularity:supersedes a55a6f74
-- singularity:phase expand
CREATE TABLE "table_mirror_keys" (
	"replica_id" text NOT NULL,
	"tbl" text NOT NULL,
	"pk" jsonb NOT NULL,
	"h" text NOT NULL,
	CONSTRAINT "table_mirror_keys_replica_id_tbl_pk_pk" PRIMARY KEY("replica_id","tbl","pk")
);
CREATE TABLE "table_mirror_replicas" (
	"id" text PRIMARY KEY NOT NULL,
	"set_id" text NOT NULL,
	"sink" text NOT NULL,
	"schema_name" text,
	"phase" text DEFAULT 'empty' NOT NULL,
	"progress" jsonb,
	"local_tables" jsonb,
	"source_identity" jsonb,
	"fingerprints" jsonb,
	"floor" "xid8",
	"after" jsonb,
	"pass_xmin" "xid8",
	"seq" integer DEFAULT 0 NOT NULL,
	"source_now" timestamp with time zone,
	"last_synced_at" timestamp with time zone,
	"copied_at" timestamp with time zone,
	"last_attempt_at" timestamp with time zone,
	"last_outcome" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "table_mirror_replicas_schema_name_unique" UNIQUE("schema_name")
);
-- singularity:phase contract
ALTER TABLE "table_mirror_keys" ADD CONSTRAINT "table_mirror_keys_replica_id_table_mirror_replicas_id_fk" FOREIGN KEY ("replica_id") REFERENCES "public"."table_mirror_replicas"("id") ON DELETE cascade ON UPDATE no action;
-- singularity:claims
