import { sql } from "drizzle-orm";
import { db } from "@plugins/database/server";
import type { PlaceCandidate } from "@plugins/integrations/plugins/google-maps/plugins/places-api/core";
import { askCandidateRows } from "./tables";

/**
 * Adds a search's candidates to the run's, by place id. Merged in SQL
 * (`jsonb ||`), so two searches the agent runs at once both land.
 */
export async function recordCandidates(
  conversationId: string,
  found: readonly PlaceCandidate[],
): Promise<void> {
  if (found.length === 0) return;
  const t = askCandidateRows.table;
  const candidates = Object.fromEntries(found.map((c) => [c.placeId, c]));
  await db
    .insert(t)
    .values({ conversationId, candidates })
    .onConflictDoUpdate({
      target: t.conversationId,
      set: { candidates: sql`${t.candidates} || excluded.candidates` },
    });
}

/** The place ids the run's searches returned. */
export async function candidateIds(
  conversationId: string,
): Promise<ReadonlySet<string>> {
  const row = await askCandidateRows.get(conversationId);
  return new Set(row === undefined ? [] : Object.keys(row.candidates));
}
