-- singularity:snapshot id=d795b926-da39-4ba5-8240-f52e065ea7ad parents=a00fe99c-4c11-450d-a7e0-2de76b7bbc9d
-- singularity:supersedes c171a868
-- singularity:phase expand
ALTER TABLE "conversations" ADD COLUMN "title_by_user" boolean DEFAULT false NOT NULL;
-- singularity:phase contract
-- singularity:claims
