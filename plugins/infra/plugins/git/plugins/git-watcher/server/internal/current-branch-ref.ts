import { GIT } from "@plugins/infra/plugins/paths/server";
import { REPO_ROOT } from "@plugins/infra/plugins/paths/plugins/repo-root/core";
import { spawnCaptured } from "@plugins/infra/plugins/spawn/core";

// `symbolic-ref` reads one file. This runs while the git watcher is being set
// up, so a child that never returns would leave ref-watching silently never
// armed; thirty seconds is orders of magnitude above the read and only a wedge
// reaches it.
const GIT_TIMEOUT_MS = 30_000;

// The full ref name (`refs/heads/<branch>`) this worktree's HEAD points at, or
// null when HEAD is detached. Resolved against the current worktree's checkout
// (REPO_ROOT) — this is the ref a local commit / rebase / sync-to-head advances.
export async function currentBranchRef(): Promise<string | null> {
  const result = await spawnCaptured([GIT, "symbolic-ref", "--quiet", "HEAD"], {
    cwd: REPO_ROOT,
    timeoutMs: GIT_TIMEOUT_MS,
  });
  if (result.exitCode !== 0) return null; // detached HEAD
  const ref = result.stdout.trim();
  return ref.length > 0 ? ref : null;
}
