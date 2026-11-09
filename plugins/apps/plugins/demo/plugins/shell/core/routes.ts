import { defineRoute } from "@plugins/primitives/plugins/pane/core";

/**
 * The demo page's routes: where the visitor is INSIDE the demo is the page's
 * own URL, so a reload, a bookmark or a link comes back to it.
 *
 * - `/demo` — the demo at its start (the demo composition's home app); it
 *   settles on the location route at once.
 * - `/demo/at/<location>` — the demo at `<location>`, the embed's app-rooted
 *   URL without its leading slash (`/demo/at/agents/c/<id>`,
 *   `/demo/at/desktop/sonata`). The static `at/` keeps a location from
 *   reading as another pane's segment.
 * - `…;full=1` — the same place, full screen: the demo is the whole page
 *   instead of a frame under the caption (what a new browser tab opened from
 *   inside the demo shows).
 */
export const demoStartRoute = defineRoute({ id: "demo-start", segment: "" });

/** The demo at one location, framed or (`;full=1`) full screen. */
export const demoAtRoute = defineRoute({
  id: "demo-at",
  segment: "at/:url*;full",
});

/** `full`'s one value. */
export const DEMO_FULL = "1";
