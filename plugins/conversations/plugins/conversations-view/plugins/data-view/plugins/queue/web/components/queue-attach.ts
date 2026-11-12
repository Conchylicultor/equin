import {
  exposedColumns,
  type ContributedColumns,
} from "@plugins/network/plugins/live/core";
import type { DataViewAttachConfig } from "@plugins/primitives/plugins/data-view/web";
import { taskManagerShape } from "@plugins/tasks/plugins/orchestration/plugins/watch/core";
import type { QueueRow } from "./use-queue-rows";

/** The task's manager, as every row reaching a task carries it (`$columns`). */
const managerColumns = exposedColumns(taskManagerShape.exposure);

/**
 * The task a queue conversation is drawn beneath: its task's manager (the
 * task whose live agent watches it — a supervisor watching what it filed), or
 * `null` — the person's own task, or one whose agent is waiting on the person
 * (a question, a permission), which surfaces as a row of its own until it is
 * answered. The ONE rule both the DataView's `attach` and the queue's step
 * flags read, so a row the list nests is never counted among the rows a step
 * moves past.
 */
export function queueParentTaskId(row: {
  readonly waitingFor: string | null;
  readonly $columns: ContributedColumns;
}): string | null {
  if (row.waitingFor != null) return null;
  return managerColumns.read(row).managerTaskId ?? null;
}

/**
 * The tasks whose supervised work is running: every manager, up the chain, of
 * a task with a working or starting live conversation — so a supervisor that
 * waits on its agents reads under Working rather than among the groups waiting
 * on the person. The manager relation is the one {@link queueParentTaskId}
 * reads, taken whatever the row waits for (a supervisor asking the person
 * something still has its own manager waiting on it).
 */
export function supervisingTaskIds(
  live: readonly {
    readonly taskId: string;
    readonly status: string;
    readonly $columns: ContributedColumns;
  }[],
): Set<string> {
  const managerOf = new Map<string, string>();
  for (const row of live) {
    const manager = managerColumns.read(row).managerTaskId;
    if (manager != null && manager !== row.taskId)
      managerOf.set(row.taskId, manager);
  }
  const supervising = new Set<string>();
  for (const row of live) {
    if (row.status !== "working" && row.status !== "starting") continue;
    // Walk up the managers; a task already marked had its chain walked.
    let manager = managerOf.get(row.taskId);
    while (manager !== undefined && !supervising.has(manager)) {
      supervising.add(manager);
      manager = managerOf.get(manager);
    }
  }
  return supervising;
}

/**
 * Supervised tasks drawn beneath their supervisor's row, in its section,
 * whatever their own status — their own status still shows on their row. A
 * finished conversation (Done) stays in Done.
 */
export const QUEUE_ATTACH: DataViewAttachConfig<QueueRow> = {
  getKey: (r) => r.taskId,
  getParentKey: (r) => (r.section === "done" ? null : queueParentTaskId(r)),
  defaultExpanded: true,
};

/** A ranked group's step affordances: first, last, and whether it can move down. */
export interface StepFlags {
  isTop: boolean;
  isBottom: boolean;
  canStepDown: boolean;
}

/**
 * Each group's step flags, counted over the groups of its section the list
 * draws as rows of their own (`topLevel`): a group drawn beneath its
 * supervisor is no row a step moves past, and has no step of its own.
 */
export function stepFlags<G>(
  groups: readonly G[],
  topLevel: (group: G) => boolean,
): Map<G, StepFlags> {
  const shown = groups.filter(topLevel);
  const flags = new Map<G, StepFlags>();
  for (const group of groups) {
    const idx = shown.indexOf(group);
    flags.set(
      group,
      idx === -1
        ? { isTop: false, isBottom: false, canStepDown: false }
        : {
            isTop: idx === 0,
            isBottom: idx === shown.length - 1,
            canStepDown: idx < shown.length - 1,
          },
    );
  }
  return flags;
}
