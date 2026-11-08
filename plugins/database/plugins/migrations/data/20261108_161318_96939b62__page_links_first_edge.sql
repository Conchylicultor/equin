-- singularity:snapshot id=82446467-6b57-45eb-8d2e-34e735afd742 parents=60dec196-7ede-4019-b83e-532e4ffe7dbe
-- singularity:phase expand
ALTER TABLE "page_links" ADD COLUMN "first" boolean DEFAULT false NOT NULL;
-- singularity:phase contract
-- singularity:claims
