-- singularity:snapshot id=d60f08a0-e56e-4e26-973c-61e1e0ead0b3 parents=263b78bc-f0bc-461f-b657-2cff4a7c8182
-- singularity:supersedes b3d1622c
-- singularity:phase expand
ALTER TABLE "latency_ledger_interaction" ADD COLUMN "client_id" text;
ALTER TABLE "latency_ledger_interaction" ADD COLUMN "automated" boolean DEFAULT false NOT NULL;
CREATE INDEX "latency_ledger_interaction_client_idx" ON "latency_ledger_interaction" USING btree ("client_id","occurred_at");
-- singularity:phase contract
-- singularity:claims
