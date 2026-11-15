import { embedTailPath } from "@plugins/primitives/plugins/pane/core";
import { defineWebsitePage } from "@plugins/apps/plugins/website/plugins/crawlable/core";

/** The live demo on its own page, at `/about/demo`. */
export const demoPage = defineWebsitePage({
  path: "/about/demo",
  title: "Demo",
  description:
    "equin itself, running entirely in your browser on made-up data: the Agent Manager, Pages, Prototypes, Sonata and Keyboard Party, live.",
});

/**
 * The demo page at `place` — `/about/demo/at/agents/c/x`, its embed tail;
 * bare `/about/demo` for no place or the root.
 */
export function demoPagePath(place: string | undefined): string {
  return place === undefined || place.replace(/^\/+/, "") === ""
    ? demoPage.path
    : demoPage.path + embedTailPath(place);
}
