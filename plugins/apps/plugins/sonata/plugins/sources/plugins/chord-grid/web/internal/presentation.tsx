import { FieldPresentation } from "@plugins/network/plugins/live/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { songChordGridShape } from "../../core";
import { gridChordNames } from "./cover-chords";

const chordsIcon = symbol("grid-view");

/** How many chords the Chords cell names before it stops. */
const CELL_CHORDS = 4;

/**
 * The Chords field of every list of songs — a chord grid's text, from the
 * chord-grid exposure (`songChordGridShape`): a card property row, a table
 * column, a sort key and a filter dimension at once. The cell names the
 * grid's first chords (`C · G · Am · F`); a song with no grid reads null and
 * the cell renders nothing, so the library card stays source-agnostic.
 */
export const chordGridPresentation = FieldPresentation.Register({
  owner: songChordGridShape.exposure,
  fields: {
    chordText: {
      icon: chordsIcon,
      cell: (text) => {
        if (text === null) return null;
        const names = gridChordNames(text, CELL_CHORDS);
        return names.length === 0 ? null : names.join(" · ");
      },
    },
  },
});
