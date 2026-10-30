import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@plugins/database/server";
import type { SearchDoc } from "../../core";
import { _searchDocuments } from "./tables";

// Generic index-mutation helpers consumers call from their own reindex jobs.
// The engine owns the table; consumers own what they put in it.

// `excluded.<col>` reference for an onConflictDoUpdate SET clause — the value
// that would have been inserted for the conflicting row.
function excluded(column: { name: string }) {
  return sql`excluded.${sql.identifier(column.name)}`;
}

// Insert or replace the search documents. Keyed on (source, entityId): an
// existing row is updated in place (title/body/route/metadata), so reindexers
// can call this idempotently. `tsv` is a generated column — Postgres recomputes
// it from the new title/body automatically.
export async function upsertSearchDocs(docs: SearchDoc[]): Promise<void> {
  if (docs.length === 0) return;
  await db
    .insert(_searchDocuments)
    .values(
      docs.map((doc) => ({
        source: doc.source,
        entityId: doc.entityId,
        title: doc.title,
        body: doc.body,
        route: doc.route,
        metadata: doc.metadata ?? {},
      })),
    )
    .onConflictDoUpdate({
      target: [_searchDocuments.source, _searchDocuments.entityId],
      set: {
        title: excluded(_searchDocuments.title),
        body: excluded(_searchDocuments.body),
        route: excluded(_searchDocuments.route),
        metadata: excluded(_searchDocuments.metadata),
      },
    });
}

// Remove specific documents within a source (e.g. on entity delete).
export async function deleteSearchDocs(
  source: string,
  entityIds: string[],
): Promise<void> {
  if (entityIds.length === 0) return;
  await db
    .delete(_searchDocuments)
    .where(
      and(
        eq(_searchDocuments.source, source),
        inArray(_searchDocuments.entityId, entityIds),
      ),
    );
}

// Wipe an entire source (used by full backfills before reseeding).
export async function deleteSource(source: string): Promise<void> {
  await db.delete(_searchDocuments).where(eq(_searchDocuments.source, source));
}

// Read back the (entityId → metadata) pairs currently indexed for a source, so a
// consumer's backfill can compare its own per-doc bookkeeping stamped into
// `metadata` (e.g. a content fingerprint) against freshly-derived state and skip
// upserting docs that are unchanged. Domain-agnostic: the engine round-trips the
// opaque `metadata` bag and never interprets it.
export async function getSourceDocMetadata(
  source: string,
): Promise<{ entityId: string; metadata: Record<string, unknown> }[]> {
  const rows = await db
    .select({
      entityId: _searchDocuments.entityId,
      metadata: _searchDocuments.metadata,
    })
    .from(_searchDocuments)
    .where(eq(_searchDocuments.source, source));
  return rows.map((r) => ({
    entityId: r.entityId,
    metadata: r.metadata,
  }));
}
