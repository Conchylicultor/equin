import type { Song } from "@plugins/apps/plugins/sonata/plugins/library/core";
import type { SongCoverAnswer } from "@plugins/apps/plugins/sonata/plugins/library/web";
import { MIDI_SOURCE_ID } from "../../shared/constants";
import { midiCoverUrl } from "../../shared/endpoints";

/**
 * A MIDI song's cover: its falling-notes roll, drawn on the server from the
 * song's own MIDI and versioned by `sourcesChangedAt` (a re-import is a new
 * URL). Any other song is not this source's to answer for.
 */
export const midiCover = (song: Song): SongCoverAnswer | undefined =>
  song.source === MIDI_SOURCE_ID
    ? {
        kind: "art",
        content: {
          kind: "image",
          src: midiCoverUrl(song.id, song.sourcesChangedAt),
        },
      }
    : undefined;
