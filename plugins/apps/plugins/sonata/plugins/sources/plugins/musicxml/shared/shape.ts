import { textField } from "@plugins/fields/plugins/text/plugins/config/core";
import { defineExtensionShape } from "@plugins/infra/plugins/entity-extensions/core";

/**
 * One song's persisted MusicXML, stored in the `sonata_songs_ext_musicxml`
 * entity-extension table (1:1 with `sonata_songs`, FK CASCADE on song delete),
 * which `server/internal/tables.ts` builds from this shape. Its wire form (the
 * attachment, read by the player's hydration through `songMusicXmlRows`) keeps
 * the dedup hash off the wire.
 */
export const songMusicXmlShape = defineExtensionShape({
  key: "songId",
  fields: {
    // Points at the stored `.musicxml` document.
    attachmentId: textField(),
    // SHA-256 hex of the document's bytes — the content-dedup key of the
    // library import (the same file imported twice opens the one song).
    contentHash: textField(),
  },
  // The dedup key is the server's business (`server/internal/import.ts`); the
  // browser never reads it.
  serverOnly: ["contentHash"],
});
