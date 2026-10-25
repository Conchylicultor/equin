import { defineRoute } from "@plugins/primitives/plugins/pane/core";

/**
 * The player pane's route, `/sonata/song/:songId;bar;lens` (the pane itself is
 * `sonataPlayerPane`, web). In `core/` so a caller outside the app can build a
 * link to a song — `sonataPlayerRoute.link(sonataApp, { songId })` — without
 * importing the library's web barrel, which would pull the library into the
 * eager boot tier ahead of the sources it hydrates songs from.
 */
export const sonataPlayerRoute = defineRoute({
  id: "sonata-player",
  segment: "song/:songId;bar;lens",
});
