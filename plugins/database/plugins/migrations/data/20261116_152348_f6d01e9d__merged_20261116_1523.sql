-- singularity:snapshot id=35672749-9912-44ba-baf8-d2de49dbf4d7 parents=e0b7471b-de9a-4dcf-952e-90664c4cffea
-- singularity:supersedes 69b252d9
-- singularity:phase expand
ALTER TABLE "latency_ledger_interaction" ADD COLUMN "place_key" text;
-- singularity:phase contract
-- singularity:claims
