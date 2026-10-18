import { z } from "zod";
import {
  fieldsToZodObject,
  nullable,
  type FieldsRecord,
} from "@plugins/fields/core";
import { textField } from "@plugins/fields/plugins/text/plugins/config/core";
import { boolField } from "@plugins/fields/plugins/bool/plugins/config/core";
import { dateField } from "@plugins/fields/plugins/date/plugins/config/core";
import { floatField } from "@plugins/fields/plugins/float/plugins/config/core";
import { entityRef } from "@plugins/infra/plugins/entities/core";
import { idKindField } from "@plugins/ids/core";
import { songIdKind } from "@plugins/apps/plugins/sonata/plugins/library/core";

// One persisted per-(song, track) view override. `color` is nullable: null means
// "no override — fall back to the palette default for the track's index".
// `instrument` is likewise nullable: null means "auto" — derive the timbre from
// the track's GM program, else the default instrument. `muted` silences the
// track in the audio scheduler; `hidden` removes its notes from the piano-roll.
// Both default to false so an absent row reads as "audible + visible".
//
// `volume` is the track's fader position, a plain **linear gain multiplier**:
// `1` is unity (the track exactly as recorded), `0` is silent, `2` is +6 dB.
// It is deliberately not a dB value and not a 0–100 percentage — the audio
// engine writes it straight into a `GainNode.gain`, so any other unit would put
// a conversion between the persisted number and the thing it controls. It
// defaults to 1, so an absent row reads as "audible + visible + unity gain".
// Note that `volume: 0` is NOT the same state as `muted: true`: mute drops the
// track's notes upstream (it gets no channel in the engine at all), while a
// fader at zero is a position on a channel that stays alive and scheduled.
//
// The physical table (server) and the wire schema both derive from this single
// `trackViewFields` record; the created/updated timestamps stay in the DDL but
// are kept off the wire as `trackViewServerFields`.
export const trackViewFields = {
  songId: idKindField(songIdKind),
  trackId: textField(),
  color: nullable(textField()),
  instrument: nullable(textField()),
  muted: boolField(),
  hidden: boolField(),
  volume: floatField({ min: 0, max: 2, default: 1 }),
} satisfies FieldsRecord;

/** The `sonata_track_view` entity (the wire fields; timestamps are server fields). */
export const trackViewEntityRef = entityRef(
  "sonata_track_view",
  trackViewFields,
);

// Columns present in the table DDL but never on the wire (the loader never
// fetches them): the created/updated timestamps the client never reads.
export const trackViewServerFields = {
  createdAt: dateField(),
  updatedAt: dateField(),
} satisfies FieldsRecord;

// Client-facing row shape — 7 fields (omits the timestamps). Browser-safe.
export const TrackViewRowSchema = fieldsToZodObject(trackViewFields);
export type TrackViewRow = z.infer<typeof TrackViewRowSchema>;
