import { sql, type SQL, type SQLWrapper } from "drizzle-orm";
import type {
  AggregateRef,
  ColumnRef,
} from "@plugins/infra/plugins/query-resource/core";

// THE derivations of the tasks tree, written once (P8 v3 step 19): an
// attempt's status / active / retained / finished_at from its two rollup rows,
// a task's per-attempt facts (the aggregates over its attempts), a task's
// status / active / finished_at from those facts, and the rule for "this
// dependency still blocks what depends on it".
//
// Two readers interpolate them, and they must never disagree:
//
//  - the derived views (`views.ts`: `attempts_v`, `task_blocking_v`,
//    `tasks_v`), over drizzle columns and CTE columns; and
//  - the `tasks` live collection (`task-rows.ts`), over the `all` compiler's
//    refs — a nested rollup's columns, a children / closure join's aggregates.
//
// Each builder takes the facts it reads as operands (anything drizzle's `sql`
// interpolates as a value) and returns fresh SQL per call, so a caller may
// `.mapWith` / `.as` its result without touching another caller's. The
// all-parity suite pins the two readers equal row for row.

/**
 * A value expression drizzle's `sql` interpolates: a column, a SQL fragment,
 * or a query-resource ref (a compile's column or aggregate read, which renders
 * as SQL at runtime).
 */
export type SqlOperand =
  SQLWrapper | ColumnRef | AggregateRef<string, string, unknown>;

/**
 * One attempt's two rollup rows, read through LEFT joins: every column is
 * NULL for an attempt with no conversation (`attempt_conv_agg`) / no push
 * (`attempt_push_agg`).
 */
export interface AttemptFacts {
  hasConv: SqlOperand;
  hasLiveConv: SqlOperand;
  hasOpenConv: SqlOperand;
  maxEndedAt: SqlOperand;
  hasPush: SqlOperand;
  /** Some landing is a recorded delivery (scratch), not a push. */
  hasDelivery: SqlOperand;
  /** An agent is computing on the attempt (`starting` / `working`). */
  hasWorkingConv: SqlOperand;
  minPushAt: SqlOperand;
}

/**
 * An attempt's derived columns. See `views.ts` (`attempts_v`) for why each arm
 * reads what it reads — I6 (every arm names a fact the row proves), and the
 * PROGRESS (`active`) vs RETENTION (`retained`) notions.
 */
export function attemptDerived(f: AttemptFacts): {
  /** `AttemptStatus`, never NULL. */
  status: SQL;
  /** `status = 'completed'`, never NULL. */
  completed: SQL;
  /** PROGRESS: an agent is expected to be running. Never NULL. */
  active: SQL;
  /** RETENTION: the user has not finished with it. Never NULL. */
  retained: SQL;
  /** `timestamptz`, NULL unless the attempt is over (`completed` / `closed`). */
  finishedAt: SQL;
} {
  const status = () => sql`
        CASE
          WHEN ${f.hasConv} IS NULL                              THEN 'pending'
          WHEN ${f.hasLiveConv} AND ${f.hasPush} IS NULL                THEN 'in_progress'
          WHEN ${f.hasDelivery}
            AND NOT COALESCE(${f.hasWorkingConv}, false)                 THEN 'completed'
          WHEN ${f.hasLiveConv} AND ${f.hasPush}                       THEN 'pushed'
          WHEN ${f.hasPush}                                            THEN 'completed'
          WHEN ${f.hasOpenConv}                                        THEN 'dormant'
          ELSE                                                               'closed'
        END
      `;
  return {
    status: status(),
    completed: sql`((${status()}) = 'completed')`,
    active: sql`(${f.hasConv} IS NULL OR ${f.hasLiveConv})`,
    retained: sql`(${f.hasConv} IS NULL OR ${f.hasOpenConv})`,
    finishedAt: sql`
        CASE
          WHEN ${f.hasConv} AND ${f.hasPush}
            AND (NOT COALESCE(${f.hasLiveConv}, false)
                 OR (${f.hasDelivery}
                     AND NOT COALESCE(${f.hasWorkingConv}, false)))      THEN ${f.minPushAt}
          WHEN ${f.hasConv} AND NOT COALESCE(${f.hasOpenConv}, false)
            AND ${f.hasPush} IS NULL                                     THEN ${f.maxEndedAt}
          ELSE                                                           NULL
        END
      `,
  };
}

/**
 * A task's facts over its attempts — each an AGGREGATE over the task's attempt
 * rows (with their rollups), so a caller groups by the attempt's `task_id`.
 * Over no attempt (a task never attempted) every one is NULL: the caller
 * coalesces (`false` for the flags; `minPushAt` stays NULL).
 *
 * `minPushAt` is the earliest push of ANY of the task's attempts — the min of
 * each attempt's `attempt_push_agg.min_push_at`, which is exactly the min over
 * the task's pushes the old `task_completed_push` CTE grouped.
 */
export function taskAttemptAggregates(
  f: AttemptFacts & { hasWaitingConv: SqlOperand },
): {
  hasAttempt: SQL;
  hasCompleted: SQL;
  hasActive: SQL;
  hasWaiting: SQL;
  minPushAt: SQL;
} {
  const a = attemptDerived(f);
  return {
    hasAttempt: sql`bool_or(true)`,
    hasCompleted: sql`bool_or(${a.completed})`,
    // Deliberately the PROGRESS notion (`active`), not `retained`: this drives
    // the in_progress / need_action / blocked badges, which must report
    // whether an agent is actually running.
    hasActive: sql`bool_or(${a.active})`,
    hasWaiting: sql`bool_or(${f.hasWaitingConv})`,
    minPushAt: sql`min(${f.minPushAt})`,
  };
}

/** A task's own columns and its attempt facts, the flags COALESCEd (never NULL). */
export interface TaskFacts {
  heldAt: SqlOperand;
  droppedAt: SqlOperand;
  hasAttempt: SqlOperand;
  hasCompleted: SqlOperand;
  hasActive: SqlOperand;
  hasWaiting: SqlOperand;
  /** Some transitive prerequisite still blocks (`depIsBlocking` over the closure). */
  hasBlockingDep: SqlOperand;
  /** NULL when no attempt of the task ever pushed. */
  minPushAt: SqlOperand;
}

/**
 * A task's derived columns.
 *
 * Precedence — `held_at` gates the `done` branch instead of sitting below it.
 * A completed attempt (= it pushed AND has no live conversation) otherwise
 * outranked an explicit hold, so "Hold & close" on a conversation whose
 * attempt had ever pushed wrote held_at, closed the last live conversation,
 * flipped the attempt `pushed` → `completed`, and resolved the task to `done` —
 * silently discarding the hold AND emitting taskStatusChanged{status:'done'},
 * which unblocks everything downstream, so the next task launched. Hold is a
 * user's explicit "not now": it wins over `done`.
 *
 * The two blocked branches are the SAME predicate (an unresolved
 * prerequisite) split by whether an agent is running: the top one keeps its
 * precedence over `need_action` / `in_progress` — a blocked task must read as
 * blocked wherever it is shown — but reports `in_progress_blocked` so the live
 * attempt is not hidden behind it. Anything asking "is this blocked?" reads
 * `isBlockedStatus`, which covers both.
 *
 * It stays BELOW the three `hasActive` branches, mirroring the existing
 * active-overrides-dropped rule — holding a task whose agent is still running
 * reports the live truth (`in_progress`), not the intent.
 *
 * `finishedAt` carries the same held_at gate as the status, so the two never
 * contradict each other: a task reported as `held` is not finished.
 */
export function taskDerived(f: TaskFacts): {
  /** `TaskStatus`, never NULL. */
  status: SQL;
  /** Never NULL. */
  active: SQL;
  /** `timestamptz`, or NULL. */
  finishedAt: SQL;
} {
  return {
    status: sql`
        CASE
          WHEN ${f.heldAt} IS NULL AND ${f.hasCompleted}                THEN 'done'
          WHEN ${f.hasActive} AND ${f.hasBlockingDep}                   THEN 'in_progress_blocked'
          WHEN ${f.hasActive} AND ${f.hasWaiting}                       THEN 'need_action'
          WHEN ${f.hasActive}                                           THEN 'in_progress'
          WHEN ${f.droppedAt} IS NOT NULL                               THEN 'dropped'
          WHEN ${f.heldAt}    IS NOT NULL                               THEN 'held'
          WHEN ${f.hasBlockingDep}                                      THEN 'blocked'
          WHEN ${f.hasAttempt}                                          THEN 'attempted'
          ELSE                                                               'new'
        END
      `,
    active: sql`(NOT ${f.hasCompleted} AND ${f.hasActive})`,
    finishedAt: sql`
        CASE
          WHEN ${f.heldAt} IS NOT NULL                  THEN NULL
          WHEN ${f.hasCompleted}                        THEN ${f.minPushAt}
          WHEN ${f.droppedAt} IS NOT NULL               THEN ${f.droppedAt}
          ELSE                                               NULL
        END
      `,
  };
}

/**
 * THE definition of "dependency `dep` is still blocking whatever depends on
 * it" — never NULL when `hasCompleted` is not.
 *
 * Three readers interpolate it and must never disagree: the transitive closure
 * `task_blocking_v` (the auto-start gate and the `blocked` badge), the
 * deliberately single-hop direct frontier in queries/tasks.ts
 * (`listBlockingDepIds`, which feeds queue ranking) — both through
 * `views.ts` — and the `tasks` collection's blocking closure (`task-rows.ts`).
 * They differ in SHAPE, never in RULE.
 *
 * It re-derives "settled" from raw columns rather than reading a task's
 * status (the status depends on this rule — reading it would be circular), so
 * it must stay in agreement with `isSettled` (core/task-graph.ts) and
 * `taskDerived`'s status:
 *   settled ⇔ status ∈ {done, dropped}
 *   dropped ⇔ dropped_at IS NOT NULL
 *   done    ⇔ has a completed attempt AND NOT held  ← hold outranks `done`
 *
 * That last clause is why `held_at` appears here at all. Without it, a task
 * that had pushed and was then held kept the completed-attempt exemption,
 * stopped blocking, and auto-launched its armed dependents — the "Hold &
 * close marked the task done and started the next one" bug.
 */
export function depIsBlocking(dep: {
  droppedAt: SqlOperand;
  heldAt: SqlOperand;
  /** Some attempt of the dependency is `completed` (never NULL). */
  hasCompleted: SqlOperand;
}): SQL {
  return sql`(${dep.droppedAt} IS NULL AND (${dep.heldAt} IS NOT NULL OR NOT ${dep.hasCompleted}))`;
}
