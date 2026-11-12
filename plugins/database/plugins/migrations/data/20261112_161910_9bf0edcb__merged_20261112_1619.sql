-- singularity:snapshot id=04123b4d-3456-4a76-8426-348f2e954385 parents=ae2f279d-5a12-468e-9866-ed0507e3e212
-- singularity:supersedes 2a4e00e5
-- singularity:phase expand
CREATE TABLE "table_mirror_log" (
	"set_id" text NOT NULL,
	"tbl" text NOT NULL,
	"pk" jsonb NOT NULL,
	"xid" "xid8" NOT NULL,
	"deleted" boolean NOT NULL,
	CONSTRAINT "table_mirror_log_tbl_pk_pk" PRIMARY KEY("tbl","pk")
);
CREATE TABLE "table_mirror_marks" (
	"at" timestamp with time zone PRIMARY KEY NOT NULL,
	"snapshot_xmin" "xid8" NOT NULL
);
CREATE TABLE "table_mirror_source" (
	"singleton" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"source_id" uuid NOT NULL,
	"epoch" integer DEFAULT 0 NOT NULL,
	"horizon" "xid8" DEFAULT '0'::xid8 NOT NULL,
	CONSTRAINT "table_mirror_source_one_row" CHECK ("table_mirror_source"."singleton")
);
CREATE INDEX "table_mirror_log_set_xid_idx" ON "table_mirror_log" USING btree ("set_id","xid","tbl","pk");
-- singularity:phase contract
-- singularity:claims
