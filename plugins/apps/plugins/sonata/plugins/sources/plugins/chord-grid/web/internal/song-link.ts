import { useSongDocument } from "@plugins/apps/plugins/sonata/plugins/document/web";
import {
  Library,
  type SongLinkValue,
} from "@plugins/apps/plugins/sonata/plugins/library/web";
import {
  beatToSeconds,
  scoreEndBeat,
} from "@plugins/apps/plugins/sonata/plugins/score/core";
import {
  fromLinkText,
  toLinkText,
} from "@plugins/apps/plugins/sonata/plugins/library/core";
import { useMemo } from "react";
import { readyResource } from "@plugins/network/plugins/live/plugins/live-state/web";
import type { LinkPreviewResult } from "@plugins/apps/plugins/sonata/plugins/library/web";
import { asChordGridRaw, compile, type ChordGridRaw } from "../../core";
import { createChordGridSong } from "../../shared/endpoints";
import { CHORD_GRID_SOURCE_ID } from "../constants";

/**
 * The open song's grid text, as its link spells it (`;grid=`, in the
 * library's readable link spelling — `toLinkText`): the loaded
 * document's raw — so an edit reaches the address as it is typed, before its
 * debounced save — or none for a song with no chord grid.
 */
function useGridLinkValue(): SongLinkValue {
  const raw = useSongDocument().sourceRaw(CHORD_GRID_SOURCE_ID);
  return {
    known: true,
    value: raw === undefined ? null : toLinkText(asChordGridRaw(raw).text),
  };
}

/** A link's grid as the chord grid's raw — known at once: the link carries it. */
function useGridPreview(value: string): LinkPreviewResult {
  return useMemo(() => {
    const raw: ChordGridRaw = { text: fromLinkText(value) };
    return readyResource({ sourceId: CHORD_GRID_SOURCE_ID, raw });
  }, [value]);
}

/**
 * The chord grid's part of a song's link: the grid text, and — for a link to
 * a song this library does not have — the song itself: previewed from the
 * link's grid, then (Add to library) created under the link's id and title
 * with the grid's derived metrics (measured as the editor does).
 */
export const chordGridSongLink = Library.SongLink({
  key: "grid",
  useValue: useGridLinkValue,
  usePreview: useGridPreview,
  create: async ({ fetchEndpoint }, { id, title, value }) => {
    const text = fromLinkText(value);
    const score = compile({ text });
    const endBeat = scoreEndBeat(score);
    await fetchEndpoint(
      createChordGridSong,
      {},
      {
        body: {
          id,
          title,
          composer: null,
          chordText: text,
          durationSec: beatToSeconds(score, endBeat),
          endBeat,
        },
      },
    );
  },
});
