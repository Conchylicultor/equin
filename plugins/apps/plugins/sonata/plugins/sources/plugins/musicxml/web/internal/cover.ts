import type { Song } from "@plugins/apps/plugins/sonata/plugins/library/core";
import type { SongCoverAnswer } from "@plugins/apps/plugins/sonata/plugins/library/web";
import { MUSICXML_SOURCE_ID } from "../../shared/constants";
import { musicXmlCoverUrl } from "../../shared/endpoints";

/**
 * A MusicXML song's cover: a schematic grand staff of its opening bars, drawn
 * on the server from the song's own document and versioned by
 * `sourcesChangedAt` (a replaced document is a new URL). A song still being
 * transcribed has no document yet: the transcription's `pending` / `failed`
 * answer wins over this one (the library's resolver rule). Any other song is
 * not this source's to answer for.
 */
export const musicXmlCover = (song: Song): SongCoverAnswer | undefined =>
  song.source === MUSICXML_SOURCE_ID
    ? {
        kind: "art",
        content: {
          kind: "image",
          src: musicXmlCoverUrl(song.id, song.sourcesChangedAt),
        },
      }
    : undefined;
