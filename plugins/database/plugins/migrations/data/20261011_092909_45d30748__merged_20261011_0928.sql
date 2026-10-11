-- singularity:phase expand
ALTER TABLE "chord_loop_windows" ADD COLUMN "rich" boolean DEFAULT false NOT NULL;
-- singularity:phase contract
-- singularity:claims
