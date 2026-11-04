import {
  addTaskDependency,
  removeTaskDependency,
  listDependentIds,
  getTaskDependencyIds,
  readTaskStatuses,
  withTaskStatusBatch,
} from "@plugins/tasks/plugins/tasks-core/server";
import { isSettled } from "@plugins/tasks/plugins/tasks-core/core";
import { listSidequestIds } from "@plugins/tasks/plugins/task-track/server";

export interface RewireOptions {
  newTaskId: string;
  targetId: string;
  relation: "followup" | "prerequisite";
  /**
   * Followup only: rewire only these IDs. Omit to rewire every dependent that
   * is not a sidequest (see {@link DependencyGraph.spliceableDependentsOf}).
   * Empty array = rewire none.
   */
  selectiveInsertBefore?: string[];
  /** Prerequisite only: when true, don't transfer target's existing deps to the new task. */
  standalone?: boolean;
}

/**
 * The dependency edges a rewire reads and writes. An edge `add(a, b)` means
 * "a depends on b". Production binds it to one transaction (below); a test
 * binds it to an in-memory graph, so the wiring logic is the same code either
 * way.
 */
export interface DependencyGraph {
  add(taskId: string, dependsOnId: string): Promise<void>;
  remove(taskId: string, dependsOnId: string): Promise<void>;
  /**
   * The tasks that depend on `taskId` and that a followup splice moves by
   * default: every dependent except the sidequests, which stay on `taskId` —
   * a sidequest runs after the task it was filed from and is never spliced
   * into a chain, whichever path (add_task, the chain endpoint) splices.
   */
  spliceableDependentsOf(taskId: string): Promise<string[]>;
  /** The tasks `taskId` depends on. */
  dependenciesOf(taskId: string): Promise<string[]>;
  /** Of `ids`, the ones not settled (neither done nor dropped), in order. */
  unsettled(ids: readonly string[]): Promise<string[]>;
}

/** The rewire itself, over any {@link DependencyGraph}. */
export async function rewireOn(
  graph: DependencyGraph,
  opts: RewireOptions,
): Promise<void> {
  if (opts.relation === "followup") {
    await graph.add(opts.newTaskId, opts.targetId);
    // A settled dependent is never moved: it has already run (or never will),
    // so waiting on the new task means nothing — and that phantom blocker is
    // what kept stale auto-start markers on landed tasks dormant until a later
    // drop unblocked them (2026-11-04). Its edge stays on the target, where it
    // is already satisfied. Applies to an explicit `selectiveInsertBefore`
    // too: nothing can be inserted before work that is already done.
    const idsToRewire = await graph.unsettled(
      opts.selectiveInsertBefore ??
        (await graph.spliceableDependentsOf(opts.targetId)),
    );
    for (const depId of idsToRewire) {
      if (depId === opts.newTaskId) continue;
      await graph.remove(depId, opts.targetId);
      await graph.add(depId, opts.newTaskId);
    }
  } else {
    const targetDeps = opts.standalone
      ? []
      : await graph.dependenciesOf(opts.targetId);
    await graph.add(opts.targetId, opts.newTaskId);
    for (const depId of targetDeps) {
      if (depId === opts.newTaskId) continue;
      await graph.add(opts.newTaskId, depId);
      await graph.remove(opts.targetId, depId);
    }
  }
}

// Rewiring is a single logical operation ("replace edge A with edge B") that
// spans several dependency mutations. `withTaskStatusBatch` runs them all in one
// transaction and coalesces `tasks.statusChanged` to the net before→after per
// task, so a momentary zero-blocker intermediate state lives only inside the
// uncommitted transaction (invisible to the launch job, which reads a separate
// connection) and never emits a spurious `blocked → unblocked` trigger. Edge
// ordering is therefore irrelevant — remove-then-add is fine.
export async function rewireDependencies(opts: RewireOptions): Promise<void> {
  await withTaskStatusBatch(async (tx) => {
    await rewireOn(
      {
        add: (a, b) => addTaskDependency(a, b, tx),
        remove: async (a, b) => {
          await removeTaskDependency(a, b, tx);
        },
        spliceableDependentsOf: async (id) => {
          const dependents = await listDependentIds(id, tx);
          const sidequests = await listSidequestIds(dependents, tx);
          return dependents.filter((d) => !sidequests.has(d));
        },
        dependenciesOf: (id) => getTaskDependencyIds(id, tx),
        unsettled: async (ids) => {
          const statuses = await readTaskStatuses(ids, tx);
          return ids.filter((id) => {
            const row = statuses.get(id);
            if (!row) throw new Error(`rewire: task ${id} not found`);
            return !isSettled(row.status);
          });
        },
      },
      opts,
    );
  });
}
