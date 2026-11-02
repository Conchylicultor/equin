-- singularity:snapshot id=18710111-d80a-4024-813c-2813d22ace91 parents=b02e4416-c2bf-4b1c-94cd-0cfc598ff989
-- singularity:supersedes 44591de5
-- singularity:phase expand
ALTER TABLE "conversations" ADD COLUMN "resuming_since" timestamp with time zone;
-- singularity:phase contract
-- singularity:claims
