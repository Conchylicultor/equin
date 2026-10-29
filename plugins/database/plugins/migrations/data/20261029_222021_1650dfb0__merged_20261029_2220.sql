-- singularity:snapshot id=3886a0de-61e0-4fbb-9967-fd93a53098c3 parents=45f8cba3-4d04-4d79-a017-a592b04a52c6
-- singularity:supersedes 6aa698ad
-- singularity:supersedes 6aa698ad <- 0a785f55
-- singularity:phase expand
ALTER TABLE "deploy_runs" ADD COLUMN "commit_subject" text;
-- singularity:phase contract
-- singularity:claims
