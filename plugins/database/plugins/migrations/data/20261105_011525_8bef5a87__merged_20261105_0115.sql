-- singularity:snapshot id=aa274962-ff32-4eab-8eef-cffd545a145c parents=90ccefb7-b8a0-47a9-9f52-2ae5f5f45c25
-- singularity:supersedes 33d48482
-- singularity:phase expand
ALTER TABLE "job_waits" ADD COLUMN "waker_key" text;
-- singularity:phase contract
-- singularity:claims
