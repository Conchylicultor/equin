import { databaseForkedAt } from "@plugins/database/plugins/fork-point/server";

/**
 * Is a conversation this backend's own — created in this database — rather
 * than a copy the fork that made this database brought over from main's?
 *
 * A worktree's database is a fork of main's, so it holds every conversation
 * main had at that moment, with the same status. Their agents run under main's
 * backend and their transcripts are main's to follow; a worktree that follows
 * them too re-reads dozens of full transcript chains on every boot, for turns
 * whose events (fanned out to its forked copies of main's triggers) are not its
 * to emit. A conversation the worktree launched itself is created after the
 * fork point, and is its own like any of main's is main's.
 *
 * Pure, so the rule is pinned without a database: `forkedAt` is
 * `databaseForkedAt()` — null for a database never forked, which owns every row.
 */
export function isOwnConversation(
  row: { createdAt: Date },
  forkedAt: Date | null,
): boolean {
  return forkedAt === null || row.createdAt.getTime() > forkedAt.getTime();
}

/** {@link isOwnConversation} against this database's fork point. */
export async function ownConversationFilter(): Promise<
  (row: { createdAt: Date }) => boolean
> {
  const forkedAt = await databaseForkedAt();
  return (row) => isOwnConversation(row, forkedAt);
}
