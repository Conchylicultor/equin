import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { FieldPresentation } from "@plugins/network/plugins/live/web";
import { songMidiShape } from "@plugins/apps/plugins/sonata/plugins/sources/plugins/midi/core";

/**
 * The File field of every list of songs: does this folder-imported song's
 * backing `.mid` file still exist on disk? The song stays (and stays playable
 * from its copied attachment) but is visibly flagged.
 *
 * The value is the MIDI source's (`sourceMissing`, exposed by its extension —
 * a bool, so "show me the songs whose file vanished" is a filter preset run on
 * the server rather than a visual scan); its meaning is this plugin's, so the
 * cell is registered here, on the MIDI exposure. It overrides the inherited
 * checkbox: a present file renders nothing, so an ordinary song's card is
 * unchanged. A row-state mark, not a property (`indicator`): a card draws it
 * on its title line.
 */
export const sourceMissingPresentation = FieldPresentation.Register({
  owner: songMidiShape.exposure,
  fields: {
    sourceMissing: {
      indicator: true,
      cell: (missing) =>
        missing ? <Badge variant="destructive">File missing</Badge> : null,
    },
  },
});
