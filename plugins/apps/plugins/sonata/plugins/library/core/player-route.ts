import { defineRoute } from "@plugins/primitives/plugins/pane/core";

/**
 * The keyed params a song's share link carries so the song can be recreated
 * on another library: what the song IS, spelled by the plugin that owns each
 * part (a `Library.SongLink` contribution, web) — `grid`, the chord grid's
 * text, `ug`, the Ultimate Guitar tab id, and `groove`, the accompaniment. A
 * closed list, because the route's grammar is static; which plugin fills a
 * key is the contribution's business, never the library's.
 */
export const SONG_LINK_KEYS = ["grid", "ug", "groove"] as const;

/** One of {@link SONG_LINK_KEYS}. */
export type SongLinkKey = (typeof SONG_LINK_KEYS)[number];

/**
 * The player pane's route, `/sonata/song/:songId;bar;lens;title;grid;ug;groove`
 * (the pane itself is `sonataPlayerPane`, web). In `core/` so a caller outside
 * the app can build a link to a song — `sonataPlayerRoute.link(sonataApp, {
 * songId })` — without importing the library's web barrel, which would pull
 * the library into the eager boot tier ahead of the sources it hydrates songs
 * from.
 *
 * `;bar` and `;lens` are views of the song; `;title` and the
 * {@link SONG_LINK_KEYS} are the song's shareable content, written only into
 * the link the player's Share button copies. Opening such a link restores the
 * song (or offers to add it) and then drops them, so the address of an open
 * song stays the plain one.
 */
export const sonataPlayerRoute = defineRoute({
  id: "sonata-player",
  segment: "song/:songId;bar;lens;title;grid;ug;groove",
});
