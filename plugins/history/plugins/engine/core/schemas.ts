import { z } from "zod";
import { fieldsToZodObject, nullable } from "@plugins/fields/core";
import { boolField } from "@plugins/fields/plugins/bool/plugins/config/core";
import { dateField } from "@plugins/fields/plugins/date/plugins/config/core";
import { textField } from "@plugins/fields/plugins/text/plugins/config/core";

// One stored version of an entity's history. List endpoints return this
// metadata-only shape (no `snapshot` blob); `historyVersion` (the `history.version` live value) returns it plus the
// opaque snapshot. The engine is domain-agnostic: `sourceId` names the
// registered history source (e.g. "pages"), `entityId` is that source's own
// id for the versioned entity, and the snapshot payload stays opaque
// (`z.unknown()`) — only the source knows how to serialize/restore it.
//
// The fields the `history.versions` timeline lists, in its order: a timeline
// is one entity's versions, scoped by `sourceId` / `entityId` (the two
// filterable columns); the rest only sort / display (`filterable: false`).
export const VERSION_LISTED = {
  label: nullable(textField({ label: "Version", filterable: false })),
  createdAt: dateField({ label: "When", filterable: false }),
  author: nullable(textField({ label: "Author", filterable: false })),
  sourceId: textField({ label: "Source" }),
  entityId: textField({ label: "Entity" }),
};
export const VERSION_CARRIED = {
  id: textField(),
  // Immutable checkpoint (e.g. a pre-restore undo point) — never coalesced over.
  pinned: boolField(),
};
export const VersionSchema = fieldsToZodObject({
  ...VERSION_CARRIED,
  ...VERSION_LISTED,
});
export type Version = z.infer<typeof VersionSchema>;

// `historyVersion` (the `history.version` live value) adds the opaque per-source snapshot blob to the metadata.
export const VersionWithSnapshotSchema = VersionSchema.extend({
  snapshot: z.unknown(),
});
export type VersionWithSnapshot = z.infer<typeof VersionWithSnapshotSchema>;
