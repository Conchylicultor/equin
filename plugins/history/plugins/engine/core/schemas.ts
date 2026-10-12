import { z } from "zod";

// One stored version of an entity's history. List endpoints return this
// metadata-only shape (no `snapshot` blob); `historyVersion` (the `history.version` live value) returns it plus the
// opaque snapshot. The engine is domain-agnostic: `sourceId` names the
// registered history source (e.g. "pages"), `entityId` is that source's own
// id for the versioned entity, and the snapshot payload stays opaque
// (`z.unknown()`) — only the source knows how to serialize/restore it.
export const VersionSchema = z.object({
  id: z.string(),
  sourceId: z.string(),
  entityId: z.string(),
  label: z.string().nullable(),
  author: z.string().nullable(),
  // Immutable checkpoint (e.g. a pre-restore undo point) — never coalesced over.
  pinned: z.boolean(),
  createdAt: z.coerce.date(),
});
export type Version = z.infer<typeof VersionSchema>;

// `historyVersion` (the `history.version` live value) adds the opaque per-source snapshot blob to the metadata.
export const VersionWithSnapshotSchema = VersionSchema.extend({
  snapshot: z.unknown(),
});
export type VersionWithSnapshot = z.infer<typeof VersionWithSnapshotSchema>;
