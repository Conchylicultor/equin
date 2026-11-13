-- singularity:snapshot id=41eb71df-eab0-4952-8ede-5d13fff96fdd parents=937783c1-de47-4ea8-826c-abd247264374
-- singularity:supersedes 194e8335
-- singularity:phase expand
ALTER TABLE "conversation_flags" ADD COLUMN "items" jsonb;
ALTER TABLE "conversation_flags" ADD COLUMN "details" text;
-- singularity:phase contract
ALTER TABLE "conversation_flags" ALTER COLUMN "items" SET NOT NULL;
ALTER TABLE "conversation_flags" DROP COLUMN "reason";
-- singularity:claims
-- 20261113_031051__flag_items_details
