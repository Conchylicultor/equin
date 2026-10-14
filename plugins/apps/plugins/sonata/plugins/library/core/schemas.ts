import { z } from "zod";
import {
  fieldsToZodObject,
  nullable,
  type FieldsRecord,
} from "@plugins/fields/core";
import { textField } from "@plugins/fields/plugins/text/plugins/config/core";
import { floatField } from "@plugins/fields/plugins/float/plugins/config/core";
import { dateField } from "@plugins/fields/plugins/date/plugins/config/core";
import { idKindField } from "@plugins/ids/core";
import { entityRef } from "@plugins/infra/plugins/entities/core";
import { songIdKind } from "./id-kind";

/**
 * A persisted Sonata song — **source-agnostic** generic metadata only. The raw
 * per-source data (e.g. the MIDI attachment, a chord-grid's JSON) lives in each
 * source's own entity-extension side-table, owned by that source plugin; the
 * core row never names a source. `durationSec`/`endBeat` are score-level (the
 * composed timeline's length), not tied to any one source.
 *
 * The physical table (server) and this wire schema both derive from this single
 * `songFields` record, so a column/schema drift is unrepresentable. `createdAt`
 * crosses the wire as a Date (`z.coerce.date()` parses the serialised ISO string
 * back into a Date on the client); the DB defaults it to `now()`.
 *
 * `source` is the opaque id of the input source that created the song (MIDI,
 * chord-grid, …), stamped once at creation and never changed. The library treats
 * it as an opaque tag — it never enumerates or interprets source ids; the value
 * always equals the creating source's `Library.Source` / `SonataDocument.Source` id, and
 * display labels are resolved through the generic `SonataDocument.Source` registry.
 */
export const songFields = {
  id: idKindField(songIdKind),
  title: textField({ label: "Title", primary: true }),
  composer: nullable(textField({ label: "Composer" })),
  durationSec: floatField(),
  endBeat: floatField(),
  createdAt: dateField(),
  /**
   * Stamped by every source write (`updateSongMeta`). Not an `updated_at`: it is
   * a write-time stamp, not derived. The player keys source hydration on it, so
   * a source that finishes preparing a song (a transcription) re-hydrates an
   * open pane.
   */
  sourcesChangedAt: dateField(),
  source: textField({ label: "Source" }),
} satisfies FieldsRecord;

/**
 * The songs entity by reference — what browser-safe declarations name it with
 * (the library collection's `from`, an extension shape's `exposes.parent`),
 * carrying its field record. The server builds `sonata_songs` from it
 * (`defineEntity(songsEntityRef, …)`), so the two are one declaration.
 */
export const songsEntityRef = entityRef("sonata_songs", songFields);

export const SongSchema = fieldsToZodObject(songFields);

/** A song row as stored — the library collection's own fields. */
export type SongRow = z.infer<typeof SongSchema>;
