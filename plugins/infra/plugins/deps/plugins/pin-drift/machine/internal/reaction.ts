import { defineRefReaction } from "@plugins/infra/plugins/git/plugins/git-watcher/server";

const listeners = new Set<() => void>();

/** Run `fn` whenever main advances. Returns the unsubscribe. */
export function onMainMoved(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/**
 * Main moved: its bun.lock may now declare another version of a pinned
 * dependency (the weekly npm upgrade), so the pinned binaries' row re-reads —
 * in every backend, since a worktree's backend is not restarted by a push.
 */
export const pinDriftReaction = defineRefReaction({
  name: "deps.pin-drift",
  refName: "refs/heads/main",
  run: () => {
    for (const fn of listeners) fn();
    return Promise.resolve();
  },
});
