import type { TaskListItem } from "@plugins/tasks/plugins/tasks-core/core";

// One row of the dependency TREE: a task plus the single tree edge that renders
// it (its primary parent) and the fan-in prerequisites shown as chips. Generic
// over the task row so a live row keeps what it carries (`taskRows`' exposed
// fields under `$columns`, which the tree's DataView reads).
export type DepsTreeRow<T extends TaskListItem = TaskListItem> = T & {
  // Primary parent — the deterministic oldest-edge prerequisite still inside the
  // cluster. `null` ⇒ this row is a root of the tree (renders top-level). A
  // member reached only through creation edges (no in-cluster dependency) has no
  // primary parent, so it renders as an independent root here.
  depsParentId: string | null;
  // Remaining in-cluster prerequisites beyond the primary parent (fan-in),
  // rendered as removable "also after: X" chips.
  extraDeps: T[];
};

/**
 * Project the shared cluster (see {@link taskClusterIds}) as a dependency TREE.
 *
 * Every `task_dependencies` edge inside the cluster becomes a literal tree edge:
 * a task nests under its primary parent (the oldest edge in `dependencies`, which
 * `tasks_v` already orders by edge `createdAt`); any further in-cluster
 * prerequisites fan in as `extraDeps` chips. Members with no in-cluster
 * dependency — including tasks pulled in only by creation edges — render as
 * top-level roots. Settled tasks stay in rows (muted at render).
 *
 * `memberIds` is the exact set of rows to emit; the caller computes it once and
 * feeds the SAME set to the creation tree, so both views show one set two ways.
 */
export function buildDepsTree<T extends TaskListItem>(
  tasks: readonly T[],
  memberIds: ReadonlySet<string>,
): DepsTreeRow<T>[] {
  const byId = new Map(tasks.map((t) => [t.id, t]));

  const rows: DepsTreeRow<T>[] = [];
  for (const id of memberIds) {
    const task = byId.get(id);
    if (!task) continue;
    // In-cluster prerequisites, oldest edge first (the tasks_v ordering).
    const deps = task.dependencies.filter((d) => memberIds.has(d));
    const extraDeps: T[] = [];
    for (const d of deps.slice(1)) {
      const dep = byId.get(d);
      if (dep) extraDeps.push(dep);
    }
    rows.push({ ...task, depsParentId: deps[0] ?? null, extraDeps });
  }
  return rows;
}
