import {
  addTaskDependency,
  removeTaskDependency,
  getTaskDependencyIds,
  listDependentIds,
  type DbExecutor,
} from "@plugins/tasks/plugins/tasks-core/server";
import type { DepsMoveBody } from "../../core";

// Move an EXISTING task node within the dependency tree — the "relocate a node
// with heal" operation, the sibling of `rewireDependencies` ("insert a NEW
// node"). Both are pure edge algebra over `task_dependencies`; the atomicity and
// status-event coalescing come from the caller wrapping this in a single
// `withTaskStatusBatch` (see handle-deps-move.ts), so a momentary zero-blocker
// intermediate never fires auto-start. `exec` MUST be that batch's tx.
//
// Edge notation A→B = "A depends on B" = addTaskDependency(A, B). All reads are
// on `exec` so they observe the batch's own uncommitted writes.
export async function applyDepsTreeMove(
  opts: { taskId: string; newParentId: string | null; mode: DepsMoveBody["mode"] },
  exec: DbExecutor,
): Promise<void> {
  const x = opts.taskId;

  // 1. HEAL X's old position. Snapshot X's parents and children FIRST, then
  //    detach X entirely and bridge each child to EVERY old parent (cross-product
  //    — a child still runs after everything X ran after). This is what makes a
  //    chain reorder (0←1←2←3 ⇒ 0←2←1←3) expressible as one node move. Bridging
  //    can only re-add a transitive edge that already held, so it never cycles;
  //    addTaskDependency is ON CONFLICT DO NOTHING, so duplicates are harmless.
  const oldDeps = await getTaskDependencyIds(x, exec); // X's parents (X depends on these)
  const oldDependents = await listDependentIds(x, exec); // X's children (these depend on X)
  for (const p of oldDeps) {
    await removeTaskDependency(x, p, exec);
  }
  for (const c of oldDependents) {
    await removeTaskDependency(c, x, exec);
    for (const p of oldDeps) {
      await addTaskDependency(c, p, exec);
    }
  }

  // 2. ATTACH X at its new position. After heal X is fully detached (nothing
  //    depends on it, it depends on nothing), so no attach can form a cycle.
  const y = opts.newParentId;
  if (y === null) return; // healed root — ready / parallel, no parent edge
  if (opts.mode === "branch") {
    // Parallel child of Y: a single new edge, Y's existing children untouched.
    await addTaskDependency(x, y, exec);
    return;
  }
  // Splice: X inserts into the chain under Y. Snapshot Y's children AFTER heal
  // (they are the true current dependents on `exec`), add X→Y, then rewire each
  // of Y's old children onto X so they now run after X instead of directly Y.
  const yChildren = await listDependentIds(y, exec);
  await addTaskDependency(x, y, exec);
  for (const c of yChildren) {
    if (c === x) continue;
    await removeTaskDependency(c, y, exec);
    await addTaskDependency(c, x, exec);
  }
}
