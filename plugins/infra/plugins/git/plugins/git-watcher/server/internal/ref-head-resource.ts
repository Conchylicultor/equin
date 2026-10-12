import { serveValue } from "@plugins/network/plugins/live/server";
import { refHead } from "../../core";
import { readSha } from "./read-sha";

export const refHeadServed = serveValue(refHead, {
  source: "external",
  changes: "notified",
  // A rebase rewrites refs/heads/main many times in quick succession; the
  // watcher notifies per distinct sha, cascading to build.deployment +
  // commitDelta/commitsGraph (git subprocesses) in every worktree. A fixed-window
  // trailing throttle collapses a rebase's rewrites into one flush per worktree —
  // the cross-worktree storm relief. See
  // research/2026-06-15-global-live-state-cascade-contention.md (Change 2B).
  throttleMs: 300,
  loader: async ({ refName }) => ({ sha: await readSha(refName) }),
});
