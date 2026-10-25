import { getAttempt } from "@plugins/tasks/plugins/tasks-core/server";
import { implement } from "@plugins/infra/plugins/endpoints/server";
import { bulkDeleteWorktrees } from "../../shared/endpoints";
import { orphanDirPath } from "./dirs";
import { rebuildEntries } from "./entries";
import { reapAttempt } from "./reap";
import { refreshScannedRows, safeIdsOf } from "./scan-served";

const CONCURRENCY = 4;

async function deleteOne(id: string): Promise<{ id: string; ok: true } | { id: string; ok: false; error: string }> {
  // Same resolution as handle-delete: attempt row first, canonical dir orphan
  // second, neither ⇒ refuse before any filesystem or database step runs.
  const attempt = await getAttempt(id);
  const worktreePath = attempt?.worktreePath ?? (await orphanDirPath(id));
  if (!worktreePath) return { id, ok: false, error: "No such attempt or worktree" };

  try {
    await reapAttempt(id, { worktreePath });
  } catch (e) {
    return { id, ok: false, error: String(e) };
  }
  return { id, ok: true };
}

export const handleBulkDelete = implement(
  bulkDeleteWorktrees,
  async ({ body }) => {
    const scanned = safeIdsOf(body.at);
    const results: (
      { id: string; ok: true } | { id: string; ok: false; error: string }
    )[] = [];

    // The scan's safe set may be hours old (nothing tells it an attempt was
    // relaunched or a checkout dirtied), so each id is judged again, as it
    // stands now, before anything destructive runs on it.
    const current = await rebuildEntries(scanned);
    const ids: string[] = [];
    for (const id of scanned) {
      if (current.get(id)?.isSafe === true) ids.push(id);
      else results.push({ id, ok: false, error: "no longer safe" });
    }

  // Process with bounded concurrency to avoid overwhelming git locks and Postgres
  let i = 0;
  while (i < ids.length) {
    const batch = ids.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.all(batch.map(deleteOne));
    results.push(...batchResults);
    i += CONCURRENCY;
  }

    // Whatever each reap got through — and the rows found no longer safe —
    // the panel's scan re-reads.
    await refreshScannedRows(scanned);

  const succeeded = results.filter((r) => r.ok).length;
  const failed = results.filter(
    (r): r is { id: string; ok: false; error: string } => !r.ok,
  );

  return { succeeded, failed };
});
