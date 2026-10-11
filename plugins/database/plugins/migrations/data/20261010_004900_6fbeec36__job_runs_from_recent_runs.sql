-- job_runs_from_recent_runs: the jobs run-history ring moves from
-- `job_recent_runs` (composite (job_name, slot) key) to `job_runs`, whose
-- single-column `id` (generated: job_name || ':' || seq) a live collection can
-- bind. Runs in the claiming schema migration's group, after expand created
-- `job_runs` and before contract drops `job_recent_runs`, so every recorded run
-- is kept. The columns the old ring never recorded (job_id, hold, max_attempts,
-- queued_at, input) stay NULL. Idempotent: a run already copied is skipped.

INSERT INTO job_runs (
  job_name, slot, seq, started_at, finished_at, outcome, error, duration_ms, attempt
)
SELECT job_name, slot, seq, started_at, finished_at, outcome, error, duration_ms, attempt
FROM job_recent_runs
ON CONFLICT DO NOTHING;
