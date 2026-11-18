import { defineRoute } from "@plugins/primitives/plugins/pane/core";

/**
 * The keyed params a song's link carries so the song can be shared: what the
 * song IS, written into the address by the plugin that owns each part (a
 * `Library.SongLink` contribution, web) — `grid`, the chord grid's text, and
 * `groove`, the accompaniment. A closed list, because the route's grammar is
 * static; which plugin fills a key is the contribution's business, never the
 * library's.
 */
export const SONG_LINK_KEYS = ["grid", "groove"] as const;

/** One of {@link SONG_LINK_KEYS}. */
export type SongLinkKey = (typeof SONG_LINK_KEYS)[number];

/**
 * The player pane's route, `/sonata/song/:songId;bar;lens;title;grid;groove`
 * (the pane itself is `sonataPlayerPane`, web). In `core/` so a caller outside
 * the app can build a link to a song — `sonataPlayerRoute.link(sonataApp, {
 * songId })` — without importing the library's web barrel, which would pull
 * the library into the eager boot tier ahead of the sources it hydrates songs
 * from.
 *
 * `;bar` and `;lens` are views of the song; `;title`, `;grid` and `;groove`
 * are the song's shareable content (see {@link SONG_LINK_KEYS}), mirrored into
 * the address while the song is open so the address bar is a link that
 * recreates it on another library.
 */
export const sonataPlayerRoute = defineRoute({
  id: "sonata-player",
  segment: "song/:songId;bar;lens;title;grid;groove",
});
