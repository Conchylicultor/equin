-- singularity:snapshot id=fe4f5486-32b0-491a-bd3a-cefcb1d71eff parents=b92275ca-b08c-414c-ae94-6e12a85459b3
-- singularity:phase expand
ALTER TABLE "conversations" ADD COLUMN "status_unverified_since" timestamp with time zone;
-- singularity:phase contract
-- singularity:claims
