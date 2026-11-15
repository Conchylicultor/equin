-- singularity:snapshot id=16dd63e5-05bc-47b9-b1c8-7de6ed74f439 parents=cc983620-e245-458c-81c5-32c8e5a1d15c
-- singularity:supersedes ab585b32
-- singularity:phase expand
ALTER TABLE "isle_plots" ADD COLUMN "retired" boolean DEFAULT false NOT NULL;
-- singularity:phase contract
-- singularity:claims
-- 20261115_135505__isle_retire_duplicate_plots
