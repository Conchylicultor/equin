-- singularity:snapshot id=edaf80ef-b766-419b-bfdc-a74ea71d0885 parents=1f7e2de8-b76b-43c5-b253-ea6d51c35845
-- singularity:supersedes c85d65bb
-- singularity:supersedes c85d65bb <- b093b658
-- singularity:supersedes b093b658 <- b5629a36
-- singularity:supersedes b5629a36 <- 11967f46
-- singularity:phase expand
CREATE TABLE "isle_plots" (
	"world" text NOT NULL,
	"plot_id" text NOT NULL,
	"slot" text NOT NULL,
	"n" integer NOT NULL,
	"seq" integer NOT NULL,
	"category" text NOT NULL,
	"geometry" jsonb NOT NULL,
	"occupant" text,
	"moved_by_user" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "isle_plots_world_plot_id_pk" PRIMARY KEY("world","plot_id")
);
-- singularity:phase contract
CREATE UNIQUE INDEX "isle_plots_world_occupant_idx" ON "isle_plots" USING btree ("world","occupant");
-- singularity:claims
