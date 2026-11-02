import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { PageMap } from "@plugins/page/plugins/map/web";
import { OpenInPlacesAction } from "./components/open-in-places-action";

export {
  usePageOverlay,
  type PageOverlay,
  type PageOverlayPage,
} from "./internal/use-page-overlay";

export default {
  description:
    "A page's places laid over the Places map, web half: usePageOverlay(pageId) reads the page (title, icon), its blocks and your saved places live and joins them — loading, failed, the page missing, or its Google places numbered in page order, each matched to your saved place — and Open in Places — an icon button (the pane Expand glyph) contributed to the page map block's top-right corner (PageMap.Action), revealed on hover — links to /places;page=<pageId> (the map pane's ;page view, placesMapRoute — owned here so the page side needs no import of places-map).",
  contributions: [
    PageMap.Action({ id: "open-in-places", component: OpenInPlacesAction }),
  ],
} satisfies PluginDefinition;
