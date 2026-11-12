# A worktree fork inherits no execution

## Context

conv-1794444277-xmynd7 (and earlier conv-1794313925-mknyk5) ran TWICE in the same
worktree. Main created the conversation, its `conversations.spawn` workflow
suspended on `prepare:wait:*` (the worktree checkout), and the worktree DB was
forked ~10 s later. The fork copied the suspended run:

- `job_waits` — the pending `prepare:wait:0` row (public table, not excluded);
- `job_steps` — the run's memoized steps (public table, not excluded);
- the one-shot runtime row in `supervised_run_ended_triggers` that `ctx.waitFor`
  writes to wake the run (target `jobs.resume`).

graphile's rows (`graphile_worker`) and `supervised_job_runs` were already left
behind, so the timeout racer did not come across. But once the worktree's own
backend booted, its supervised-run watcher emitted `supervisedRun.ended` for the
checkout run (the exit marker lives on the shared machine), the copied trigger
matched, `jobs.resume` found the copied PENDING wait, resolved it and re-queued
`conversations.spawn` in the fork. The replayed spawn launched a second agent of
the same conversation id, which then took the copied held launch turn.

`isOwnConversation` keeps the status reconciler off main's rows, but nothing kept
the fork's job system off main's in-flight runs.

## Rule

A forked database starts with **no execution of its source**: everything the job
system uses to run, resume or replay a run is the source's and is not copied —
the queue (graphile, already), supervised runs (already), and now the durable-run
logs. Declared by the owner of the tables, with the existing fork-exclusion
contribution, so it is data and the fork code names no consumer table.

## Change

1. `infra/jobs` declares `ExcludeFromFork` for `job_steps` and
   `job_waits` in `machine/internal/fork-exclusion.ts`, together with
   graphile's schema exclusion (`jobsForkExclusions`, spread into `jobs#machine`'s
   contributions — the desktop is the only host whose database is forked, and
   the portable `server/` barrel must not import `database/admin`): the step and wait logs of a run are bookkeeping of the queue
   that ran it, exactly like graphile's rows. Without a wait row, `jobs.resume`
   finds "nothing to resume" and returns; without step rows, a keyed run the
   fork starts on the same key cannot replay main's memoized side-effects either.
2. The copied one-shot trigger rows (`declared = false`, target `jobs.resume`)
   are therefore inert: their delivery resumes nothing. They are a row subset of
   N per-event tables, which the table-level exclusion cannot express; leaving
   them is safe, and they are deleted when they fire (one-shot).
3. Test (`infra/jobs/machine/internal/fork-inherits-no-runs.test.ts`): a throwaway
   source with the real migration chain holds a suspended spawn (a pending wait,
   a step, its timeout racer queued in graphile); `forkDatabase` with
   `jobsForkExclusions`; in the fork there is no pending wait, no step and no
   queued row, and `keysInFlight` says the run is not in flight — while the
   source still has all of it. Without the new exclusions the test fails.

## Other in-flight state audited

| state | copied before? | verdict |
| --- | --- | --- |
| graphile jobs / crontab watermarks | no (`ExcludeSchemaDataFromFork`) | ok |
| `supervised_job_runs` | no | ok |
| `job_steps`, `job_waits` | **yes** | excluded now |
| `*_triggers` runtime one-shot rows | yes | inert without their wait (above) |
| `jobs_in_process_rows` / `_schedules` | n/a — empty on the desktop (in-process queue is never booted there) | ok |
| held turns (`conversation_turns` state `held`) | yes | delivered only by the spawn (no longer replayed) or by status/lifecycle paths that act on own conversations only |
| `events.dispatch` outbox | graphile rows → no | ok |
| reports outbox | files, not DB | n/a |
| `improve_pending_groups` | yes | passive (cleared by an event about the task); no execution |

## Verification

- `./equin test plugins/infra/plugins/jobs/machine/internal/fork-inherits-no-runs.test.ts`
- `./equin check` (plugin docs regenerate the contribution list).
