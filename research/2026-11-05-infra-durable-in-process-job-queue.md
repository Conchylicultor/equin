# A browser host's job queue survives a reload

Task: att-1793897487 (main track of "apps running in the browser"; design page
block-c0ff62ec-ef7d-44a2-bc97-84423191b2fd). Related sidequest:
task-1793668411-8f86f1 (scheduled retention sweeps rarely run in a browser host).

## Context

A browser host keeps its database (PGlite) and its four host stores in IndexedDB
(`framework/browser-server/host-storage`). The in-process `JobQueue`
(`infra/jobs/in-process`) is the one piece of host state still in memory:

- a row queued by a write but not run yet (pages.history's 4 s debounce, a search
  index, a backlink derivation) is lost when the last tab closes, so the stored
  data keeps a derived row stale for good;
- a schedule's missed ticks never catch up (a tick fires only while a tab is open
  at that minute);
- **found while designing**: row ids are an in-memory counter restarting at 1
  each boot, while the durable run's step and wait logs (`job_steps`,
  `job_waits`, in the database) are keyed `"<job>:job:<id>"`
  (`workflowRunIdFor`). On a persisted database, a run cut short leaves step rows
  that a later boot's row with the same number replays as its own.

## Design: the rows live in the host's own database

The desktop's graphile queue keeps its rows in the database the writes go to, and
a `tx` enqueue inserts in the caller's transaction. The in-process queue does the
same on whatever database the host booted (PGlite in a browser, in memory in a
test), so durability is the database's, with no second store to keep in step:

- **Tables** (drizzle, `in-process/server/internal/tables.ts`, so the one
  migration history creates them and later versions migrate them like any other
  table; they exist empty on the desktop, which never boots this queue):
  - `jobs_in_process_rows` — id (text, minted by the queue: a uuid, so a run id
    is never reused across boots), job name, payload (jsonb), job key, run at,
    attempts, max attempts, dead, last error, created / updated at.
  - `jobs_in_process_schedules` — job name → last execution (the cron watermark).
- **Atomic with the caller.** A `tx` enqueue inserts its row inside the caller's
  transaction and joins the in-memory set at commit (`afterCommit`); a rollback
  drops both. A non-`tx` enqueue inserts, then joins.
- **Memory stays the working copy**: timers, the Debug → Queue answers,
  `keysInFlight`, `settle`. Every change of a row is written through before the
  in-memory change is announced: key collapse (the older row updated, the new
  one deleted), a run's failure (attempts, run at / dead, last error), retry,
  cancel, and the delete on completion.
- **Running is not persisted.** At `start()` the rows load from the table; a row
  that was running when the host ended is pending again and runs again
  (at-least-once, as graphile's crash recovery; jobs are written for retries,
  and the durable `ctx` replays completed steps). Rows sharing a key (a crash
  between a collapse's two writes) collapse again on load, the newest winning.
- `settle`, retries, `jobKey` replace mode and `answerJobsInMemory` keep their
  behaviour.

## Missed ticks: the desktop's `catchUpWithinMs`

`ScheduleSpec.catchUpWithinMs` already says what a missed tick means on the
desktop (graphile's `backfillPeriod` over `known_crontabs.last_execution`): run
the latest tick missed while no worker ran, once, if it is at most that old. The
in-process queue now honours it the same way, so a schedule means the same on
every host:

- each tick records its time in `jobs_in_process_schedules`;
- at `schedule()`, a job with a watermark whose latest due tick in
  `(watermark, now]` is within `catchUpWithinMs` gets one tick now
  (`_cron: { ts, backfilled: true }`, its singleton key collapsing repeats);
- a job seen for the first time records now and backfills nothing (graphile's
  rule).

So the retention sweeps of task-1793668411-8f86f1 catch up on the next open once
they declare `catchUpWithinMs` — a declaration on the job, the same on the
desktop; this change provides the mechanism, not that declaration.

## Not chosen: a host-storage store written through

The four host stores' pattern (`hostStorage().store("jobs")`) would keep the
rows in a second IndexedDB database. Its write lands after the database commit,
in another database: a tab closed between them keeps the write and loses its
job — the bug this fixes, narrowed rather than removed. It would also leave the
id collision and need a second schema story.

## Verification

- `memory-queue.test.ts` keeps its fake-runner suite, now over an in-memory PGlite
  with the committed migrations.
- New proof (`durable.test.ts`, a fresh child process like `stored-data.test.ts`,
  PGlite on a `nodefs` temp dir): a job enqueued (in a committed transaction, and
  one rolled back) while the queue is not started; the host closes; a new queue on
  the reopened database starts and runs exactly the committed job. Plus: a keyed
  collapse survives, a dead row stays dead, and a missed tick within
  `catchUpWithinMs` runs once at `schedule()` (none outside it, none on first
  sight).
- `./equin build`; demo e2e: no-leak, app-switch, desktop-in-demo,
  prototypes-in-demo, sonata-in-demo, persistence.
