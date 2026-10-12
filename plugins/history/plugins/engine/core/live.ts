import { liveCollection, liveValue } from "@plugins/network/plugins/live/core";
import { liveText } from "@plugins/network/plugins/live/plugins/filter/core";
import { VersionSchema, VersionWithSnapshotSchema } from "./schemas";

/**
 * Version metadata (no snapshot blobs — the timeline is cheap to list) as a
 * live collection over `entity_versions`. A timeline is one entity's versions:
 * `useLive(historyVersions, { where: { sourceId, entityId } })`, newest first by
 * default. Live, so a snapshot recorded (or coalesced into, within its merge
 * window), a restore's "Before restore" point and the retention sweep all reach
 * an open timeline without a refetch.
 *
 * Bounded: 100 by default, grown to at most 500. `recordVersion` coalesces
 * edits inside a ~10-minute window and retention keeps 30 days, so one entity's
 * timeline rarely needs more than the default window. A scroll collection, so
 * the version-history dialog's DataView reads it as live key-range pages.
 */
export const historyVersions = liveCollection("history.versions", {
  row: VersionSchema,
  id: "id",
  filterable: { sourceId: liveText(), entityId: liveText() },
  sortable: ["createdAt"],
  default: { orderBy: [["createdAt", "desc"]], limit: 100 },
  maxLimit: 500,
  scroll: true,
});

/**
 * One version with its opaque per-source snapshot. A `db` value, not immutable:
 * the newest unpinned version is coalesced into (its snapshot rewritten) while
 * its ~10-minute merge window is open, and retention deletes it after 30 days —
 * a version that does not exist for this (source, entity) is refused `missing`.
 */
export const historyVersion = liveValue("history.version", {
  schema: VersionWithSnapshotSchema,
  params: ["sourceId", "entityId", "versionId"],
  refusals: ["missing"],
});
