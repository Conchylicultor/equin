import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "@plugins/database/server";
import { getHistorySource } from "./registry";
import { versionIdKind } from "../../core";
import { _entityVersions } from "./tables";

// Notion-style time bucketing: edits within one ~10-min active-editing window
// collapse onto a single version rather than minting one per save.
const WINDOW_MS = 10 * 60 * 1000;

/**
 * Capture a version of `entityId` within `sourceId`. Coalesces by time bucket:
 * if the newest version is within `WINDOW_MS`, overwrite it in place (sliding
 * the `createdAt` to now, so a long session yields one version timestamped at
 * the last edit); otherwise insert a new version.
 *
 * `opts.pin` records the version as an immutable checkpoint (never coalesced
 * over) — used for the pre-restore undo point so it always survives as a
 * distinct timeline entry. `opts.label` overrides the source-provided label.
 *
 * Coalescing targets the newest *unpinned* version: pinned checkpoints (and any
 * auto-snapshot taken after one) are never overwritten, so a post-restore
 * snapshot lands as a new row rather than clobbering the "Before restore" point.
 *
 * No-ops if the source is unregistered (self-heals a stale binding).
 */
export async function recordVersion(
  sourceId: string,
  entityId: string,
  opts?: { pin?: boolean; label?: string },
): Promise<void> {
  const source = getHistorySource(sourceId);
  if (!source) return;

  const captured = await source.serialize(entityId);
  if (!captured) return; // source declined (e.g. entity deleted) — skip cleanly
  const { snapshot, label, author } = captured;
  const finalLabel = opts?.label ?? label ?? null;
  const finalAuthor = author ?? null;
  const now = new Date();

  if (opts?.pin) {
    await db.insert(_entityVersions).values({
      id: versionIdKind.mint(),
      sourceId,
      entityId,
      snapshot,
      label: finalLabel,
      author: finalAuthor,
      pinned: true,
      createdAt: now,
    });
    return;
  }

  // A pin is a timeline barrier: coalesce only into the ABSOLUTE newest version,
  // and only when it is unpinned. A pinned newest row forces a fresh insert
  // (never overwrite the checkpoint, and never reach behind it into an older
  // auto-snapshot).
  const [newest] = await db
    .select()
    .from(_entityVersions)
    .where(
      and(
        eq(_entityVersions.sourceId, sourceId),
        eq(_entityVersions.entityId, entityId),
      ),
    )
    .orderBy(desc(_entityVersions.createdAt))
    .limit(1);

  if (
    newest &&
    !newest.pinned &&
    now.getTime() - newest.createdAt.getTime() < WINDOW_MS
  ) {
    await db
      .update(_entityVersions)
      .set({ snapshot, label: finalLabel, author: finalAuthor, createdAt: now })
      .where(eq(_entityVersions.id, newest.id));
  } else {
    await db.insert(_entityVersions).values({
      id: versionIdKind.mint(),
      sourceId,
      entityId,
      snapshot,
      label: finalLabel,
      author: finalAuthor,
      pinned: false,
      createdAt: now,
    });
  }
}

/**
 * Remove all versions for the given entities within a source (e.g. on entity
 * delete). Mirrors search's `deleteSearchDocs` so consumers never touch the
 * engine table directly.
 */
export async function deleteVersions(
  sourceId: string,
  entityIds: string[],
): Promise<void> {
  if (entityIds.length === 0) return;
  await db
    .delete(_entityVersions)
    .where(
      and(
        eq(_entityVersions.sourceId, sourceId),
        inArray(_entityVersions.entityId, entityIds),
      ),
    );
}
