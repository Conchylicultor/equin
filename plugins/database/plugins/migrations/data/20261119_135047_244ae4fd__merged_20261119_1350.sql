-- singularity:snapshot id=d85ac621-8f7e-4ff1-b8c2-0591df62f09a parents=a250919b-ea37-485d-b940-faec2f166d3e
-- singularity:supersedes e7fe43e3
-- singularity:phase expand
ALTER TABLE "site_reports" ADD COLUMN "category" text;
-- singularity:phase contract
-- singularity:claims
-- 20261119_133959__website_visitor_slowness_rekind
