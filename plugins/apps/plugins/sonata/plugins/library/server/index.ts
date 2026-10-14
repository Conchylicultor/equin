import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { IdKinds } from "@plugins/ids/server";
import { songIdKind } from "../core";
import { deleteSong, updateSong } from "../core/endpoints";
import { handleDeleteSong } from "./internal/handle-delete-song";
import { handleUpdateSong } from "./internal/handle-update-song";
import { songLibraryServed } from "./internal/resources";

export { _songs } from "./internal/tables";
export { createSongRow } from "./internal/create-song-row";
export type { CreateSongRowInput } from "./internal/create-song-row";
export { updateSongMeta } from "./internal/update-song-meta";
export type { UpdateSongMetaInput } from "./internal/update-song-meta";
// The generic song↔attachment link. Source-agnostic: a song may carry linked
// attachments regardless of which source produced them. Sources call
// `songAttachments.add(songId, [attachmentId])` when persisting their raw so the
// orphan sweep never reclaims an in-use file.
export { songAttachments } from "./internal/schema-attachments";

export default {
  description:
    "Persists source-agnostic Sonata song rows (generic metadata) and serves the `sonata.songs` live collection (sortable and filterable by every field an extension exposes on the songs entity). Per-source raw lives in each source's own entity-extension; sources create songs via the exported `createSongRow` helper.",
  httpRoutes: {
    [deleteSong.route]: handleDeleteSong,
    [updateSong.route]: handleUpdateSong,
  },
  contributions: [
    IdKinds.Kind({ kind: songIdKind }),
    ...songLibraryServed.declare,
  ],
} satisfies ServerPluginDefinition;
