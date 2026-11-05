import type { TaskListItem } from "@plugins/tasks/plugins/tasks-core/core";

// A task's membership label: its persisted `clusterId` (total — a task never
// unioned carries its own id).
const label = (t: TaskListItem) => t.clusterId;

/**
 * The unified member set both trees in the deps-tree section render — the same
 * set, organized two ways (by dependency, by creation).
 *
 * Membership is a **persisted, monotone label**, not a walk of the current
 * graph. Two tasks are in the same tree iff they carry the same label. The label
 * is unioned when a membership edge is created (a dependency edge, or filing a
 * task under a folder) and is **never** un-unioned when one is removed. So a
 * task can join a tree but can never fall out of it: detaching its last edge
 * leaves it a member with no parent, and it renders as a parallel root alongside
 * the tree's other roots. That is the invariant the section relies on — before
 * this, the set was the live connected component, and removing the last edge
 * made a task vanish from the pane it was being dragged in.
 *
 * Being monotone makes membership **path-dependent** — a function of history,
 * not of current state — which is precisely why it cannot be a `derived-view` or
 * `derived-table`: both rebuild from source on every boot and would re-split
 * exactly the clusters this preserves. It has to be genuine persisted state.
 * See `research/2026-08-03-tasks-monotone-deps-tree-membership.md`.
 *
 * Returns the member ids including `rootId`; empty when `rootId` is unknown.
 */
export function taskClusterIds(
  tasks: readonly TaskListItem[],
  rootId: string,
): Set<string> {
  const root = tasks.find((t) => t.id === rootId);
  if (!root) return new Set();
  const target = label(root);
  return new Set(tasks.filter((t) => label(t) === target).map((t) => t.id));
}
