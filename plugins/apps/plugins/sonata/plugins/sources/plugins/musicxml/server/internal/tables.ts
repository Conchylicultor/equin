import { _songs } from "@plugins/apps/plugins/sonata/plugins/library/server";
import { textField } from "@plugins/fields/plugins/text/plugins/config/core";
import { defineExtensionShape } from "@plugins/infra/plugins/entity-extensions/core";
import { defineExtension } from "@plugins/infra/plugins/entity-extensions/server";

// This source's persisted data for a song, attached to the library's
// `sonata_songs` row via the entity-extensions primitive (1:1 side-table, FK
// CASCADE on song delete). Table: `sonata_songs_ext_musicxml`. The shape is
// declared here, not in `shared/`: no live resource carries the row to the
// browser (hydrate reads it through `getSongMusicXml`).
const songMusicXmlShape = defineExtensionShape({
  key: "songId",
  fields: {
    // Points at the stored `.musicxml` document.
    attachmentId: textField(),
    // SHA-256 hex of the document's bytes — the content-dedup key of the
    // library import (the same file imported twice opens the one song).
    contentHash: textField(),
  },
});
export const songMusicXml = defineExtension(
  _songs,
  "musicxml",
  songMusicXmlShape,
);
export const _songMusicXmlExt = songMusicXml.table; // drizzle-kit discovery
