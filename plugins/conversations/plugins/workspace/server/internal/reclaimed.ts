import { defineServerContribution } from "@plugins/framework/plugins/server-core/core";

/**
 * One plugin's share of an attempt's workspace: what it keeps on the attempt's
 * behalf that is worth nothing once the workspace is gone (an SDK agent's
 * state, say), and how it gives it back.
 */
export interface WorkspaceReclaimedHandler {
  /** Names the handler in errors. */
  id: string;
  /**
   * Free what this plugin holds for `attemptIds`, whose workspaces were just
   * deleted. Idempotent: an id it holds nothing for, or already freed, is a
   * no-op — the same attempt can be announced twice (a sweep retried after a
   * failure).
   */
  onReclaimed(attemptIds: readonly string[]): Promise<void>;
}

/**
 * Where a plugin hears that attempts' workspaces were reclaimed. Every reaper
 * announces through {@link announceWorkspacesReclaimed} and names no handler;
 * every handler hears every reaper and names none — so a new workspace kind's
 * reaper, or a new plugin keeping per-attempt state, needs no edit elsewhere.
 * A server contribution, not an event: the worktree reaper runs in a
 * supervised child, which collects contributions but may not enqueue.
 */
export const WorkspaceReclaimed =
  defineServerContribution<WorkspaceReclaimedHandler>("Workspace.Reclaimed", {
    docLabel: (h) => h.id,
  });

/**
 * Tell every {@link WorkspaceReclaimed} handler that `attemptIds`' workspaces
 * are gone — called by a reaper once it deleted them. Every handler runs, even
 * after one throws; then a single error names each that failed, for the
 * reaper's own containment (its workspaces are gone either way, so a handler's
 * leftovers are what the handler's own backstop collects).
 */
export async function announceWorkspacesReclaimed(
  attemptIds: readonly string[],
): Promise<void> {
  if (attemptIds.length === 0) return;
  const failures: string[] = [];
  for (const handler of WorkspaceReclaimed.getContributions()) {
    try {
      await handler.onReclaimed(attemptIds);
    } catch (err) {
      failures.push(`${handler.id}: ${String(err)}`);
    }
  }
  if (failures.length > 0) {
    throw new Error(
      `workspace reclaimed (${attemptIds.join(", ")}), but ${String(failures.length)} handler(s) failed: ${failures.join("; ")}`,
    );
  }
}
