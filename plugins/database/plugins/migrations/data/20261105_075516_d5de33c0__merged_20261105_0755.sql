-- singularity:snapshot id=fa138b7e-9a47-4771-b3a1-15addadafd8e parents=8c6c8422-f80b-4402-b20d-1afdc9a32f44
-- singularity:supersedes 61c08d58
-- singularity:phase expand
CREATE INDEX "page_blocks_page_tree_idx" ON "page_blocks" USING btree ("page_id","doc_rank") WHERE type = 'page' AND deleted_at IS NULL;
-- singularity:phase contract
-- singularity:claims
