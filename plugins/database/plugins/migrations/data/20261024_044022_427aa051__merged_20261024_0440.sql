-- singularity:snapshot id=de4900c5-46ab-4a25-9228-bd763dfdb474 parents=2cb28db2-5a12-4481-8a5e-031257c7d1d5
-- singularity:supersedes dfde6045
-- singularity:supersedes dfde6045 <- bfb4131d
-- singularity:phase expand
CREATE TABLE IF NOT EXISTS "prototype_state" (
	"id" text PRIMARY KEY NOT NULL,
	"pinned" boolean DEFAULT false NOT NULL,
	"done" boolean DEFAULT false NOT NULL,
	"tag_id" text,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE IF NOT EXISTS "prototype_tags" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"parent_id" text,
	"color" text,
	"child_colors" text,
	"icon" text,
	"rank" "rank_text" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
ALTER TABLE "place_tags" ADD COLUMN "tree_rank" "rank_text";
CREATE INDEX IF NOT EXISTS "prototype_tags_parent_rank_idx" ON "prototype_tags" USING btree ("parent_id","rank");
CREATE INDEX IF NOT EXISTS "place_tags_parent_rank_idx" ON "place_tags" USING btree ("parent_id","tree_rank");
-- singularity:phase contract
ALTER TABLE "place_tags" ALTER COLUMN "tree_rank" SET NOT NULL;
DO $$ BEGIN
 ALTER TABLE "prototype_state" ADD CONSTRAINT "prototype_state_tag_id_prototype_tags_id_fk" FOREIGN KEY ("tag_id") REFERENCES "public"."prototype_tags"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
ALTER TABLE "place_tags" DROP COLUMN IF EXISTS "rank";
-- singularity:claims
-- 20261021_022603__place_tags_fractional_rank
