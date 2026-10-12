import { useLiveRow } from "@plugins/network/plugins/live/web";
import { appLink } from "@plugins/apps-core/plugins/tabs/web";
import type { LinkTarget } from "@plugins/primitives/plugins/link-gesture/core";
import { rowReferent } from "@plugins/active-data/plugins/id-chip/web";
import {
  sonataPlayerRoute,
  songIdKind,
  songLibrary,
} from "@plugins/apps/plugins/sonata/plugins/library/core";
import { sonataApp } from "@plugins/apps/plugins/sonata/plugins/shell/core";
import type { IdReferentState } from "@plugins/ids/web";

/** A song's chip title — its title — from the library's by-id row read. */
export function useSongReferent(id: string): IdReferentState {
  return rowReferent(
    useLiveRow(songLibrary, songIdKind.key(id)),
    (song) => song.title,
  );
}

/**
 * The link to the song in Sonata's player. The player is a full-surface pane
 * of another app, so it is reached by URL (`appLink`), not pushed beside the
 * surface holding the id. The link is built from the route in the library's
 * `core/`: importing its web barrel here would make the library eager (chips
 * load at boot) and split it from the deferred sources a player hydrates from.
 */
export function useSongTarget(): (id: string) => LinkTarget {
  return (id) =>
    appLink(sonataPlayerRoute.link(sonataApp, { songId: songIdKind.key(id) }));
}
