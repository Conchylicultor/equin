import { z } from "zod";
import { liveCollection } from "@plugins/network/plugins/live/core";
import { intField } from "@plugins/fields/plugins/int/plugins/config/core";
import { defineExtensionShape } from "@plugins/infra/plugins/entity-extensions/core";

/**
 * One song's global transpose offset, in semitones. The player shifts the whole
 * song (notes, voiced chords, chord labels, songsheet chord text, displayed key)
 * by this amount — see the `transpose` plugin's observer, which feeds it into the
 * shell's score pipeline. Stored in the `sonata_songs_ext_transpose`
 * entity-extension table (1:1 per song; an absent row reads as `0`), which
 * `server/internal/tables.ts` builds from this shape.
 */
export const transposeShape = defineExtensionShape({
  key: "songId",
  fields: { semitones: intField() },
});
export const TransposeRowSchema = transposeShape.schema;
export type TransposeRow = z.infer<typeof TransposeRowSchema>;

/**
 * The transpose offset of ONE song, read by the song's id: a lookup-only
 * collection over the extension table (no default window — nothing lists every
 * song's offset), minting `sonata-transpose:rows` alone. The observer reads the
 * open song's row with `useLiveRow(transposes, songId)`; `found: false` is an
 * absent row, i.e. `0`. The `:rows` point routing sends a write to the one song
 * it touched, and only a tab that has that song open subscribes to it.
 */
export const transposes = liveCollection("sonata-transpose", {
  from: transposeShape,
  id: "songId",
});
