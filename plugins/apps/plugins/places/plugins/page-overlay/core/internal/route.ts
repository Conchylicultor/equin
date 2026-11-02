import { defineRoute } from "@plugins/primitives/plugins/pane/core";

/**
 * The Places app's index route — bare `/places`, the plain map — and its one
 * keyed param, `;page`: one page's places laid over the map
 * (`/places;page=<pageId>`). A VIEW of the one map pane, not a pane of its
 * own: opening, closing and back / forward change a param of the mounted map,
 * never remount it.
 *
 * Owned here, not by `places-map` (whose index pane it is): the page-side
 * "Open in Places" links to it, and `places-map` imports this plugin, never
 * the reverse.
 */
export const placesMapRoute = defineRoute({
  id: "places-map",
  segment: ";page",
});
