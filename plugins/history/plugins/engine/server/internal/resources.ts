import { and, eq } from "drizzle-orm";
import { db } from "@plugins/database/server";
import {
  serveCollection,
  serveValue,
} from "@plugins/network/plugins/live/server";
import { historyVersion, historyVersions } from "../../core/live";
import type { VersionWithSnapshot } from "../../core/schemas";
import { versionIdKind } from "../../core/id-kind";
import { _entityVersions } from "./tables";

// The version timeline over `entity_versions`: every `Version` field is a
// column by name, and the projection is exactly the row schema — so the
// opaque `snapshot` blob never rides the timeline. A timeline window filters
// on (sourceId, entityId), served by the (source_id, entity_id, created_at)
// index; the change feed routes a recorded, coalesced, restored or swept
// version to the windows holding it.
export const historyVersionsServed = serveCollection(historyVersions, {
  from: _entityVersions,
});

// One version with its snapshot. Read-set tracked (`entity_versions`), so a
// coalesce into the version while its merge window is open, or its deletion,
// recomputes the open previews.
export const historyVersionServed = serveValue(historyVersion, {
  source: "db",
  loader: async ({ sourceId, entityId, versionId }) => {
    const [row] = await db
      .select()
      .from(_entityVersions)
      .where(
        and(
          eq(_entityVersions.id, versionIdKind.key(versionId)),
          eq(_entityVersions.sourceId, sourceId),
          eq(_entityVersions.entityId, entityId),
        ),
      )
      .limit(1);
    if (!row) throw historyVersion.refuse("missing", "Version not found");
    return {
      id: row.id,
      sourceId: row.sourceId,
      entityId: row.entityId,
      label: row.label,
      author: row.author,
      pinned: row.pinned,
      createdAt: row.createdAt,
      snapshot: row.snapshot,
    } satisfies VersionWithSnapshot;
  },
});
