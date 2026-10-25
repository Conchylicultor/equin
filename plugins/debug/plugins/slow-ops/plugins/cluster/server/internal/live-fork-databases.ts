import { listDatabases } from "@plugins/database/plugins/admin/server";
import { listAttempts } from "@plugins/tasks/plugins/tasks-core/server";
import { MAIN_WORKTREE_NAME } from "@plugins/infra/plugins/namespace/core";

// A fork DB is only worth scanning if its attempt is still live: the host
// accumulates 1000+ finished worktree forks (most without even a `slow_ops`
// table), so blindly fanning out over every database in `listDatabases()` opens
// a thousand pools to surface a handful of error rows. We restrict the fan-out
// to the main DB plus forks whose attempt is active or created in the last 24h.
const RECENT_FORK_WINDOW_MS = 24 * 60 * 60 * 1000;

export async function listLiveForkDatabases(now: number): Promise<string[]> {
  const [dbNames, attempts] = await Promise.all([listDatabases(), listAttempts()]);
  const dbSet = new Set(dbNames);
  const relevant = new Set<string>();
  if (dbSet.has(MAIN_WORKTREE_NAME)) relevant.add(MAIN_WORKTREE_NAME);
  for (const a of attempts) {
    if (!dbSet.has(a.id)) continue;
    const live = a.active || now - a.createdAt.getTime() < RECENT_FORK_WINDOW_MS;
    if (live) relevant.add(a.id);
  }
  return [...relevant];
}
