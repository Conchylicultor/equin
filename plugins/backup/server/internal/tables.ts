import { MAIN_WORKTREE_NAME } from "@plugins/infra/plugins/namespace/core";
import { sql } from "drizzle-orm";
import { index, uniqueIndex } from "drizzle-orm/pg-core";
import { nullable } from "@plugins/fields/core";
import { intField } from "@plugins/fields/plugins/int/plugins/config/core";
import {
  defineEntity,
  defaultNow,
} from "@plugins/infra/plugins/entities/server";
import { backupRunsEntityRef } from "../../core/entity";

// Built from `backupRunFields` (core/entity.ts).
//
// `namespace`:
// The namespace whose backend CLAIMED this run — not a property of the
// backup, which is host-global (see the runs arm, which still reports
// `namespace: null` for exactly that reason). It is here for the two things
// that need a scope and have none otherwise:
//
//   - a worktree DB is a fork of main's and inherits main's rows, so an
//     unscoped `listUnfinished` would hand every worktree's supervised-run
//     reconciler main's live backup — to adopt, to tail a transcript that
//     does not exist there, and to close with an outcome nobody observed;
//   - the partial unique index below needs a column to contend on, and
//     "one in flight per namespace" is exactly today's behaviour (the job
//     was `dedup: "singleton"`, which is per-database and therefore already
//     per-namespace).
//
// In practice nearly always `MAIN_WORKTREE_NAME` — the schedule is main-only
// — but a worktree can still claim one through the manual trigger, which is
// exactly why the scope has to be real rather than assumed. Backfills to the
// same value, since every historical row was claimed on main.
//
// **The runs arm still projects `namespace: null`, and that is correct.**
// This column records who CLAIMED the run; a backup covers the machine. Do
// not "fix" the arm to surface it.
//
// `pid`, the server field:
// OS pid of the detached `./singularity supervised-exec backup.run` process
// that owns this run. Seeded with the claiming backend's own pid so the row
// is not read as an orphan in the window before the child exists, then
// repointed at the child. Its liveness — never a clock — is what says
// whether the backup is still going.
const backupRunsEntity = defineEntity(
  backupRunsEntityRef,
  { pid: nullable(intField()) },
  {
    primaryKey: "id",
    columns: {
      namespace: { default: MAIN_WORKTREE_NAME },
      startedAt: { default: defaultNow() },
      status: { default: "running" },
    },
    indexes: (t) => [
      // At most one in-flight backup per namespace, enforced atomically by the
      // DB. **THE lock**: the claiming INSERT is what wins or loses, and the
      // loser gets a 23505 and returns cleanly instead of starting a second
      // backup into the same host-global `BACKUPS_DIR`.
      //
      // This replaces the job's old `dedup: "singleton"`, which could not survive
      // the move out of process: a supervised job is `dedup: "none"` (see that
      // plugin's CLAUDE.md), and a queue-level dedup would in any case only have
      // bounded the REQUEST, never the detached child that outlives the backend
      // which made it.
      uniqueIndex("backup_runs_inflight_uniq")
        .on(t.namespace)
        .where(sql`${t.finishedAt} IS NULL`),
      // Covers the unified runs query's per-arm subselect: `ORDER BY started_at
      // DESC, id ASC LIMIT n`. Without it every page of every scroll is a top-N
      // heapsort over the whole ledger — the union's O(window) argument is
      // precisely that each arm walks its own index instead. `id` is in the index
      // because it is the keyset's tiebreak, so the seek never leaves the index to
      // break a tie.
      //
      // No namespace column to lead with, and that is not an omission: a backup is
      // host-global, so this arm carries no worktree predicate to serve. See the
      // arm's CLAUDE.md.
      index("backup_runs_started_id_idx").on(t.startedAt.desc(), t.id),
    ],
  },
);

export const _backupRuns = backupRunsEntity.table;
