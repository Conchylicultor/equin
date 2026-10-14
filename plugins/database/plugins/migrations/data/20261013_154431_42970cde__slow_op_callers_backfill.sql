-- slow_op_callers_backfill: an op's callers move from the `slow_ops.callers`
-- JSON list to `slow_op_callers`, one row per (op, caller) with additive
-- counters. Runs in the claiming schema migration's group, after expand
-- created `slow_op_callers`. The JSON carries no per-caller times, so each row
-- takes its op's first / last seen. Idempotent: a caller already copied is
-- skipped. The legacy column itself stays (a follow-up push drops it).

INSERT INTO slow_op_callers (
  worktree, operation_kind, operation, caller_kind, caller_label,
  count, total_ms, max_ms, first_seen_at, last_seen_at
)
SELECT s.worktree, s.operation_kind, s.operation,
       c ->> 'kind', c ->> 'label',
       sum((c ->> 'count')::int), sum((c ->> 'totalMs')::float8),
       max((c ->> 'maxMs')::float8),
       min(s.first_seen_at), max(s.last_seen_at)
FROM slow_ops AS s, jsonb_array_elements(s.callers) AS c
GROUP BY s.worktree, s.operation_kind, s.operation, c ->> 'kind', c ->> 'label'
ON CONFLICT DO NOTHING;
