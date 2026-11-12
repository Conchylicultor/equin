import { eq } from "drizzle-orm";
import { HttpError } from "@plugins/infra/plugins/endpoints/server";
import { rankAdjacentTo as rankAmongSiblings } from "@plugins/primitives/plugins/rank/server";
import type { RankExecutor } from "@plugins/primitives/plugins/rank/server";
import type { Rank } from "@plugins/primitives/plugins/rank/core";
import {
  PINNED_SECTION,
  conversationSectionIdKind,
  type ConversationSectionId,
  type QueueSectionKey,
} from "../../core";
import { conversationsQueue, _conversationSections } from "./tables";
import {
  lockDeck,
  rankAdjacentTo,
  rankForTop,
  reseatGroupMembers,
  seatJoiningGroup,
  setGroupSection,
  upsertRank,
} from "./queue-ranks";
import { cascadeBlockedDependents } from "./cascade-blocked";
import {
  listSections,
  requireKnownSection,
  sectionExists,
  sectionName,
  type SectionSibling,
} from "./sections";

// The queue's section writes, each the body of ONE transaction (`exec` is the
// open `tx`; every op takes `lockDeck` first). The HTTP handlers are thin
// wrappers (`db.transaction(tx => op(tx, …))`); the ops are parametrized on the
// executor so the real-DB suite drives them on a throwaway database.

/** A conversation an op files: its id and its task (its group). */
export interface FiledConversation {
  conversationId: string;
  taskId: string;
}

// Seeds a rank for an unranked conversation (the path `rerank` takes): join
// the task's group seat if it holds one, else enter at the top. An already
// ranked conversation keeps its rank untouched.
async function ensureRanked(
  exec: RankExecutor,
  { conversationId, taskId }: FiledConversation,
): Promise<void> {
  const [existing] = await exec
    .select({ rank: conversationsQueue.table.rank })
    .from(conversationsQueue.table)
    .where(eq(conversationsQueue.table.conversationId, conversationId))
    .limit(1);
  if (existing) return;
  const seat = await seatJoiningGroup(taskId, conversationId, exec);
  const rank = seat?.rank ?? (await rankForTop(conversationId, exec));
  await upsertRank(conversationId, rank, exec);
}

/**
 * File the conversation's task group into `section` (Pinned, a user section)
 * or back to the Queue (`null`). A filed conversation stays an ordinary queue
 * member — it keeps its rank and stays reorderable — so filing it back puts it
 * exactly where it was (ranks are ONE global space; a section's order is that
 * space filtered). Filing an UNRANKED conversation into a section seeds a rank
 * first, so Pin / Move to work from every section.
 */
export async function fileGroup(
  exec: RankExecutor,
  conv: FiledConversation,
  section: QueueSectionKey,
): Promise<void> {
  await lockDeck(exec);
  await requireKnownSection(section, exec);
  if (section !== null) await ensureRanked(exec, conv);
  await setGroupSection(conv.conversationId, section, exec);
}

/**
 * Move a conversation's group next to another's; with `section`, also file it
 * into that section (a cross-section drop). `rankAdjacentTo(target, zone)` is
 * right across sections because ranks are one global space.
 */
export async function reorderGroup(
  exec: RankExecutor,
  body: {
    conversationId: string;
    targetId: string;
    zone: "before" | "after";
    section?: QueueSectionKey;
  },
): Promise<void> {
  const { conversationId, targetId, zone, section } = body;
  await lockDeck(exec);
  if (section !== undefined) await requireKnownSection(section, exec);
  if (conversationId !== targetId) {
    const rank = await rankAdjacentTo(targetId, zone, exec);
    await upsertRank(conversationId, rank, exec);
    await reseatGroupMembers(conversationId, rank, exec);
    await cascadeBlockedDependents(conversationId, exec);
  }
  if (section !== undefined) {
    await setGroupSection(conversationId, section, exec);
  }
}

const NO_EXCLUDES: ReadonlySet<string> = new Set();

// Where a new section goes among the others: right after `after` (a section
// id), first (`PINNED_SECTION` — Pinned is fixed first, so "after Pinned" is
// the head of the user sections), or last when absent.
function rankForNewSection(
  sections: readonly SectionSibling[],
  after: QueueSectionKey | undefined,
): Rank {
  if (after === undefined || after === null) {
    return rankAmongSiblings(sections, null, null, "after", NO_EXCLUDES);
  }
  if (after === PINNED_SECTION) {
    return rankAmongSiblings(sections, null, null, "before", NO_EXCLUDES);
  }
  if (!sections.some((s) => s.id === after)) {
    throw new HttpError(404, `Unknown section ${after}`);
  }
  return rankAmongSiblings(sections, null, after, "after", NO_EXCLUDES);
}

/**
 * Create a user section ranked after `after` (else last); with `conversation`,
 * file that conversation's group into it in the same transaction.
 */
export async function createSection(
  exec: RankExecutor,
  input: {
    name: string;
    after?: Exclude<QueueSectionKey, null>;
    conversation?: FiledConversation;
  },
): Promise<ConversationSectionId> {
  const name = sectionName(input.name);
  const id = conversationSectionIdKind.mint();
  await lockDeck(exec);
  const rank = rankForNewSection(await listSections(exec), input.after);
  await exec
    .insert(_conversationSections)
    .values({ id, name, rank: rank.toJSON() });
  if (input.conversation) {
    await ensureRanked(exec, input.conversation);
    await setGroupSection(input.conversation.conversationId, id, exec);
  }
  return id;
}

/** Rename a user section: trimmed, never empty (400); unknown id 404. */
export async function renameSection(
  exec: RankExecutor,
  id: ConversationSectionId,
  rawName: string,
): Promise<void> {
  const name = sectionName(rawName);
  await lockDeck(exec);
  const updated = await exec
    .update(_conversationSections)
    .set({ name })
    .where(eq(_conversationSections.id, id))
    .returning({ id: _conversationSections.id });
  if (updated.length === 0) throw new HttpError(404, `Unknown section ${id}`);
}

/** Move a user section next to another among the sections. */
export async function moveSection(
  exec: RankExecutor,
  body: {
    id: ConversationSectionId;
    targetId: ConversationSectionId;
    zone: "before" | "after";
  },
): Promise<void> {
  const { id, targetId, zone } = body;
  await lockDeck(exec);
  const sections = await listSections(exec);
  for (const known of [id, targetId]) {
    if (!sections.some((s) => s.id === known)) {
      throw new HttpError(404, `Unknown section ${known}`);
    }
  }
  if (id === targetId) return;
  const rank = rankAmongSiblings(sections, null, targetId, zone, new Set([id]));
  await exec
    .update(_conversationSections)
    .set({ rank: rank.toJSON() })
    .where(eq(_conversationSections.id, id));
}

/** Delete a user section: its members go back to the Queue first. */
export async function deleteSection(
  exec: RankExecutor,
  id: ConversationSectionId,
): Promise<void> {
  await lockDeck(exec);
  if (!(await sectionExists(id, exec))) {
    throw new HttpError(404, `Unknown section ${id}`);
  }
  // Members back to the Queue first, so no row ever names a deleted section.
  await exec
    .update(conversationsQueue.table)
    .set({ section: null })
    .where(eq(conversationsQueue.table.section, id));
  await exec
    .delete(_conversationSections)
    .where(eq(_conversationSections.id, id));
}
