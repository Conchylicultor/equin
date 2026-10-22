-- singularity:supersedes 76c9b60e
-- singularity:phase expand
ALTER TABLE "mail_messages" ADD COLUMN "body_fetch_error" text;
-- singularity:phase contract
-- singularity:claims
