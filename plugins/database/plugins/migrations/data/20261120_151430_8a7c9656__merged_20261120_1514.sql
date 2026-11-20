-- singularity:snapshot id=a00fe99c-4c11-450d-a7e0-2de76b7bbc9d parents=dca84999-6b9e-4696-9508-524f8eef6055
-- singularity:supersedes 864dbef1
-- singularity:phase expand
ALTER TABLE "conversations" ADD COLUMN "mandate_ref" text;
-- singularity:phase contract
-- singularity:claims
