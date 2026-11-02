import {
  serveCollection,
  serveValue,
} from "@plugins/network/plugins/live/server";
import {
  historyVersion,
  historyVersions,
  historyVersionSnapshots,
} from "../../core";
import type { VersionWithSnapshot } from "../../core";
import { versionIdKind } from "../../core";
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

// Each version with its snapshot, by id — the row `historyVersion` follows.
export const historyVersionSnapshotsServed = serveCollection(
  historyVersionSnapshots,
  { from: _entityVersions },
);

// One version with its snapshot. It follows the version's row, so a coalesce
// into it while its merge window is open, a pin, or its deletion recomputes
// the open previews — and a version written for any other entity reaches
// none. The (source, entity) pair is checked on the followed row: a version
// of another timeline is `missing` here, as the old keyed lookup answered.
export const historyVersionServed = serveValue(historyVersion, {
  source: "db",
  follows: (follow) => ({
    version: follow(historyVersionSnapshotsServed, ({ versionId }) => ({
      ids: [versionIdKind.key(versionId)],
    })),
  }),
  loader: ({ sourceId, entityId }, { followed }) => {
    const row = followed.version[0];
    if (!row || row.sourceId !== sourceId || row.entityId !== entityId) {
      throw historyVersion.refuse("missing", "Version not found");
    }
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
