import { useMemo, type ReactNode } from "react";
import type { EmbedPlaceBinding } from "@plugins/apps-core/plugins/app-embed/web";
import {
  usePaneViews,
  type HistoryMode,
} from "@plugins/primitives/plugins/pane/web";
import { EMBED_PLACE_SURFACE } from "@plugins/primitives/plugins/pane/core";
import { withActiveRoutePrefix } from "@plugins/primitives/plugins/pane/plugins/route-prefix/web";
import { useDemoActions } from "../internal/demo-store";
import { demoPage } from "../../core";
import { DemoTarget } from "./demo-target";

/**
 * `/about/demo`: the live demo on its own page — nothing of the homepage
 * mounted. The demo fills the page (the resident draws it into this box, with
 * Restore and Esc), and its place is this page's embed tail
 * (`/about/demo/at/agents/c/x`): each move is the entry the app's own tab
 * would write, so Back walks the demo's moves, then leaves the page.
 *
 * The page names itself in words too (its declared title and description,
 * visually hidden): the demo is a picture a screen reader and a robot cannot
 * read, and a static render (the crawlable snapshot) draws only its boot
 * screen's logo.
 */
export function DemoPage(): ReactNode {
  const views = usePaneViews();
  if (views === null)
    throw new Error("The demo page is a pane: its place is its URL.");
  const location = views.values[EMBED_PLACE_SURFACE];
  const { set, href } = views;
  const { setPlace } = useDemoActions();
  const place = useMemo<EmbedPlaceBinding>(
    () => ({
      location,
      onLocationChange: (url: string, history: HistoryMode) => {
        setPlace(url);
        if (url !== location) set({ [EMBED_PLACE_SURFACE]: url }, history);
      },
      browserTabUrl: (at: string) =>
        withActiveRoutePrefix(href({ [EMBED_PLACE_SURFACE]: at })),
    }),
    [location, set, href, setPlace],
  );
  return (
    <>
      <div className="sr-only">
        <h1>{demoPage.title}</h1>
        <p>{demoPage.description}</p>
      </div>
      <DemoTarget
        kind="page"
        place={place}
        className="relative size-full bg-background"
      />
    </>
  );
}
