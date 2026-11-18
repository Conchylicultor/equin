import { defineRefReaction } from "@plugins/infra/plugins/git/plugins/git-watcher/server";
import { isMain } from "@plugins/infra/plugins/runtime-identity/core";
import { recordPinReviews } from "./decisions";

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
 * dependency (the weekly npm upgrade). On main, each pin's lag is recorded
 * first — the moment a lag starts, so its 30-day clock does not wait for the
 * weekly automation — then the pinned binaries' row re-reads, in every
 * backend, since a worktree's backend is not restarted by a push.
 */
export const pinDriftReaction = defineRefReaction({
  name: "deps.pin-drift",
  refName: "refs/heads/main",
  run: async () => {
    if (isMain()) await recordPinReviews(new Date());
    for (const fn of listeners) fn();
  },
});
