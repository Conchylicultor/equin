/**
 * The UNGATED reads the ledger's own projection needs.
 *
 * They live apart from `queries/pushes.ts` on purpose. Those accessors refresh
 * the ledger before reading (see ./freshness.ts) so no consumer can observe it
 * stale; these are what the refresh itself reads, so they must not. Splitting the
 * two sets by file means re-entering the freshness gate from inside a reconcile
 * has no spelling — there is nothing here that calls it, and nothing here is
 * exported from the plugin barrel.
 */
import { inArray, max } from "drizzle-orm";
import { db } from "@plugins/database/server";
import { _attempts, _conversations, pushes } from "../tables";

/** Which of these shas the ledger already holds. One indexed SELECT. */
export async function existingPushShas(
  shas: readonly string[],
): Promise<Set<string>> {
  if (shas.length === 0) return new Set();
  const rows = await db
    .select({ sha: pushes.sha })
    .from(pushes)
    .where(inArray(pushes.sha, [...shas]));
  return new Set(rows.map((r) => r.sha));
}

/**
 * The `attemptId` each of these conversations belongs to, for the conversations
 * this database actually holds. One query for the whole batch — the per-commit
 * `getConversation` round trip it replaces made a multi-commit push cost a DB
 * hop per commit.
 */
export async function attemptIdsByConversation(
  conversationIds: readonly string[],
): Promise<Map<string, string>> {
  if (conversationIds.length === 0) return new Map();
  const rows = await db
    .select({ id: _conversations.id, attemptId: _conversations.attemptId })
    .from(_conversations)
    .where(inArray(_conversations.id, [...conversationIds]));
  return new Map(rows.map((r) => [r.id, r.attemptId]));
}

/** Which of these attempts exist here. A push for an unknown attempt is skipped. */
export async function existingAttemptIds(
  attemptIds: readonly string[],
): Promise<Set<string>> {
  if (attemptIds.length === 0) return new Set();
  const rows = await db
    .select({ id: _attempts.id })
    .from(_attempts)
    .where(inArray(_attempts.id, [...attemptIds]));
  return new Set(rows.map((r) => r.id));
}

/**
 * The newest commit date the ledger holds, or null when it holds nothing.
 *
 * This is the ledger's own high-water mark, and it is what bounds the git walk.
 * `pushes.created_at` is the commit's COMMITTER date, which `./equin push`
 * rewrites to the push time when it rebases — so it tracks `main`'s history
 * order, not the author's clock.
 */
export async function newestPushCommittedAt(): Promise<Date | null> {
  const [row] = await db.select({ newest: max(pushes.createdAt) }).from(pushes);
  return row?.newest ?? null;
}
