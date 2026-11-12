import {
  ExcludeFromFork,
  ExcludeSchemaDataFromFork,
} from "@plugins/database/plugins/admin/server";
import { _jobSteps, _jobWaits } from "../../server/internal/tables";

// Graphile's own bookkeeping — queued jobs, worker locks, and the crontab's
// last-execution watermarks. Inheriting it is actively wrong for a fresh
// worktree: it would adopt main's pending jobs and, worse, main's
// `known_crontabs.last_execution`, silently skipping the first run of every
// scheduled job.
//
// Who puts it back: the queue's `install()` (`graphileQueue`), which the
// jobs plugin's `onReadyBlocking` runs against this backend's own database
// before any plugin's `onReady`. A database whose backend had never booted
// (a fresh worktree where `./equin test` runs before `./equin
// build`) used to have no queue schema and no way to acquire one, and a
// transactional enqueue on it failed with a bare `3F000`. Dropping the
// schema costs nothing only because something owns reinstalling it; see
// `server/internal/queue-schema.ts`.
//
// The fork used to copy this schema and then `DROP SCHEMA ... CASCADE` it
// afterwards. Excluding it at dump time reaches the same end state without
// the copy.
const queueSchema = ExcludeSchemaDataFromFork({
  schema: "graphile_worker",
  // `migrations` and nothing else. Graphile records its migration watermark
  // in that table, INSIDE the schema it owns — so emptying it too would make
  // graphile boot believing it is unmigrated and re-issue CREATE TABLE
  // against tables the fork already has. Keeping just the watermark hands
  // the fork a schema graphile already considers installed, while the rows
  // that describe MAIN's queue — pending jobs, and the
  // `known_crontabs.last_execution` watermarks that would otherwise skip the
  // first run of every scheduled job — stay behind.
  //
  // This is why the fork no longer removes the schema. A forked database is
  // born queue-capable: `enqueue(input, { tx })` works on it before any
  // backend has booted against it.
  keep: ["migrations"],
  // Two consequences worth knowing before changing this. The fork inherits
  // graphile's schema at MAIN's version, so a branch that DOWNGRADES
  // graphile-worker now meets graphile's own breaking-migration guard at
  // boot instead of quietly installing its older schema — loud, and the
  // right answer, but it is a new way to brick a worktree. And the schema's
  // sequences carry main's high-water marks, so a fork's first job id is
  // large rather than 1; that is cosmetic and not worth "fixing".
  reason:
    "Queue bookkeeping for the source database; inheriting main's pending jobs and crontab watermarks would run main's work in a fresh worktree and skip the first run of every scheduled job. The migration watermark is kept so the fork's schema is already installed.",
});

// A forked database inherits no EXECUTION of its source. A run belongs to the
// database whose queue ran it: graphile's rows are left behind (`queueSchema`
// above), and so must everything a run is resumed or
// replayed from — its step log and its wait log.
//
// Why both, and why it matters: on 2026-11-12 main's `conversations.spawn` for
// conv-1794444277-xmynd7 was suspended on its checkout wait when the worktree's
// database was forked. The fork copied the PENDING `job_waits` row (and the
// one-shot `ctx.waitFor` trigger row that wakes it). Once the worktree's own
// backend booted, its supervised-run watcher emitted `supervisedRun.ended` for
// that checkout, the copied trigger handed it to `jobs.resume`, which found the
// copied wait still pending, resolved it and re-queued the spawn — IN THE FORK.
// The spawn launched a second agent of the same conversation into the same
// checkout. With no wait row, a copied trigger's resume finds "nothing to
// resume" and returns; with no step rows, a keyed run the fork starts on a key
// main had in flight cannot replay main's memoized side effects either.
//
// The trigger rows themselves stay: they are a row subset spread over one table
// per event, and without their wait they are inert (deleted when they fire).
const runLogs = [
  ExcludeFromFork({
    table: _jobSteps,
    reason:
      "The step logs of runs the source's queue ran: replaying them in a fork would hand a run there side effects it never performed.",
  }),
  ExcludeFromFork({
    table: _jobWaits,
    reason:
      "The wait logs of runs the source's queue suspended: a copied pending wait is a run the fork's own job runner would resume — main's spawn, resumed in a worktree, launched a second agent of the same conversation (2026-11-12).",
  }),
];

/**
 * Everything a forked database must not inherit of its source's job queue: the
 * queue itself and every run's step and wait logs — a fork inherits no run.
 * Declared here, on the desktop (the only host whose database is forked), so
 * the portable `server/` barrel stays free of `database/admin`.
 */
export const jobsForkExclusions = [queueSchema, ...runLogs];
