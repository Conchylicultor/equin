import { FieldPresentation } from "@plugins/network/plugins/live/web";
import { songMidiShape } from "../../core";

/**
 * The Tracks field of every list of songs — the note-bearing track count of a
 * song's MIDI file, from the MIDI exposure (`songMidiShape`): a card property
 * row, a table column, a sort key and a filter dimension at once, sorted and
 * filtered on the server. A song with no MIDI reads null, and the cell renders
 * nothing, so the library card stays source-agnostic.
 *
 * `sourceMissing`'s "File missing" badge is the `folders` sub-plugin's
 * registration on the same exposure.
 */
export const midiPresentation = FieldPresentation.Register({
  owner: songMidiShape.exposure,
  fields: {
    trackCount: {
      cell: (n) => (n === null ? null : `${n} ${n === 1 ? "track" : "tracks"}`),
      width: "5rem",
      align: "end",
    },
  },
});
