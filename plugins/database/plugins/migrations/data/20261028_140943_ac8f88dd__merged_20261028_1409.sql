-- singularity:snapshot id=a2cae672-1f0c-4924-8dae-9a84acf30632 parents=35e0e396-7f2a-48de-aa13-1772d8c11f0f
-- singularity:supersedes ea53e4ab
-- singularity:supersedes ea53e4ab <- 08dca60b
-- singularity:phase expand
-- singularity:phase contract
ALTER TABLE "event_source_runs" ALTER COLUMN "duration_ms" SET DATA TYPE double precision;
ALTER TABLE "backup_runs" ALTER COLUMN "archive_size_bytes" SET DATA TYPE double precision;
ALTER TABLE "claude_cli_calls" ALTER COLUMN "duration_ms" SET DATA TYPE double precision;
ALTER TABLE "job_runs" ALTER COLUMN "duration_ms" SET DATA TYPE double precision;
-- singularity:claims
