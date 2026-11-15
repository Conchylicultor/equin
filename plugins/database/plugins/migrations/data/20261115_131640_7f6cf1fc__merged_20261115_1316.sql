-- singularity:snapshot id=cc983620-e245-458c-81c5-32c8e5a1d15c parents=3519ddf0-f7c2-430e-867d-d9cb27d45082
-- singularity:supersedes 8ebf406f
-- singularity:phase expand
ALTER TABLE "isle_plots" ADD COLUMN "wild" boolean DEFAULT false NOT NULL;
-- singularity:phase contract
-- singularity:claims
