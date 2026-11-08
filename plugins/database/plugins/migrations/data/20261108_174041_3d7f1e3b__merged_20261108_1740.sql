-- singularity:snapshot id=c187774b-eb1e-4898-8d7f-02c93c1f1062 parents=9f401d92-b693-427e-a038-0aa7ace678e0
-- singularity:supersedes b59ce2dc
-- singularity:phase expand
ALTER TABLE "page_links" ADD COLUMN "first" boolean DEFAULT false NOT NULL;
-- singularity:phase contract
-- singularity:claims
-- 20261108_163255__page_links_first_backfill
