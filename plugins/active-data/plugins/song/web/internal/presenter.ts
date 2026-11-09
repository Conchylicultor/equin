import { useLive } from "@plugins/network/plugins/live/web";
import {
  paneTarget,
  type PaneTarget,
} from "@plugins/primitives/plugins/pane/web";
import { songPeekPane } from "@plugins/apps/plugins/sonata/plugins/library/web";
import { rowReferent } from "@plugins/active-data/plugins/id-chip/web";
import {
  songIdKind,
  songLibrary,
} from "@plugins/apps/plugins/sonata/plugins/library/core";
import type { IdReferentState } from "@plugins/ids/web";

/** A song's chip title — its title — from the library's by-id row read. */
export function useSongReferent(id: string): IdReferentState {
  return rowReferent(
    useLive(songLibrary, { id: songIdKind.key(id) }),
    (song) => song.title,
  );
}

/**
 * The song's peek: Sonata's mini player as a column beside the text holding
 * the id, so the conversation stays on screen; its Expand opens the full
 * player in Sonata.
 */
export function useSongPane(id: string): PaneTarget {
  return paneTarget(songPeekPane, { songId: songIdKind.key(id) });
}
