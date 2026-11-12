import { asc, eq } from "drizzle-orm";
import { HttpError } from "@plugins/infra/plugins/endpoints/server";
import type { RankExecutor } from "@plugins/primitives/plugins/rank/server";
import {
  PINNED_SECTION,
  type ConversationSectionId,
  type QueueSectionKey,
} from "../../core";
import { _conversationSections } from "./tables";

/** One user section as `rankAdjacentTo` reads it (one flat sibling list). */
export interface SectionSibling {
  id: ConversationSectionId;
  parentId: null;
  rank: string;
}

/** Every user section, rank order — the complete sibling set a rank is minted against. */
export async function listSections(
  executor: RankExecutor,
): Promise<SectionSibling[]> {
  const rows = await executor
    .select({ id: _conversationSections.id, rank: _conversationSections.rank })
    .from(_conversationSections)
    .orderBy(asc(_conversationSections.rank));
  return rows.map((r) => ({ id: r.id, parentId: null, rank: r.rank }));
}

export async function sectionExists(
  id: ConversationSectionId,
  executor: RankExecutor,
): Promise<boolean> {
  const [row] = await executor
    .select({ id: _conversationSections.id })
    .from(_conversationSections)
    .where(eq(_conversationSections.id, id))
    .limit(1);
  return row !== undefined;
}

/**
 * A section key a write is about to store must name something that exists:
 * the Queue (`null`), Pinned, or a user section still in the table — never a
 * dangling reference. Throws a 404 otherwise.
 */
export async function requireKnownSection(
  section: QueueSectionKey,
  executor: RankExecutor,
): Promise<void> {
  if (section === null || section === PINNED_SECTION) return;
  if (!(await sectionExists(section, executor))) {
    throw new HttpError(404, `Unknown section ${section}`);
  }
}

/** A section name as stored: trimmed, and never empty (400). */
export function sectionName(name: string): string {
  const trimmed = name.trim();
  if (trimmed === "")
    throw new HttpError(400, "A section name cannot be empty");
  return trimmed;
}
