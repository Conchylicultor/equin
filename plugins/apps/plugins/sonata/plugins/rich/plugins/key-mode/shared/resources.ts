import { z } from "zod";
import { liveCollection } from "@plugins/network/plugins/live/core";
import { boolField } from "@plugins/fields/plugins/bool/plugins/config/core";
import { defineExtensionShape } from "@plugins/infra/plugins/entity-extensions/core";

/**
 * One song's key-source mode. When `enabled`, the song's authored key (MIDI
 * header) is ignored and the key is auto-detected from the notes instead — see
 * the `key-mode` plugin's observer, which feeds this into the shell's score
 * pipeline. Stored in the `sonata_songs_ext_key_auto_detect` entity-extension
 * table (1:1 per song; an absent row reads as `false`), which
 * `server/internal/tables.ts` builds from this shape.
 */
export const keyAutoDetectShape = defineExtensionShape({
  key: "songId",
  fields: { enabled: boolField() },
});
export const KeyAutoDetectRowSchema = keyAutoDetectShape.schema;
export type KeyAutoDetectRow = z.infer<typeof KeyAutoDetectRowSchema>;

/**
 * The key-auto-detect setting of ONE song, read by the song's id: a lookup-only
 * collection over the extension table (nothing lists every song's setting),
 * minting `sonata-key-auto-detect:rows` alone. The observer reads the open
 * song's row with `useLiveRow(keyAutoDetects, songId)`; `found: false` is an
 * absent row, i.e. `false`.
 */
export const keyAutoDetects = liveCollection("sonata-key-auto-detect", {
  from: keyAutoDetectShape,
  id: "songId",
});
