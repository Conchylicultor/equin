import { FullPane } from "@plugins/layouts/plugins/full-pane/web";
import { SurfaceOverlay } from "@plugins/primitives/plugins/overlay/plugins/surface-overlay/web";
import { AnalyticsTracker } from "@plugins/apps/plugins/deploy/plugins/analytics/plugins/collect/web";
import { websiteApp } from "../../core";
import { Website } from "../slots";

/**
 * The website's app surface. A pure full-surface app (like Sonata): the
 * full-pane renderer paints the active site pane — landing at `/about`,
 * pillars / downloads at their own segments — filling the whole surface. The
 * persistent site header is NOT a layout concern: it is the shared
 * `WebsiteHeader` pane-header slot every website pane borrows, so navigation
 * chrome and pane chrome are one bar.
 *
 * The visit tracker is mounted here, beside the pane renderer rather than inside
 * any pane's chrome: this component is the app's surface, which stays mounted
 * while the visitor moves between pages, whereas each page's `WebsiteChrome`
 * is replaced with the pane it wraps. The same holds for what floats over the
 * pages (`Website.Layer`: the consent prompt) and for what must outlive a
 * page switch (`Website.Resident`: the live demo's server).
 *
 * The layers float over the page, so they are drawn in a `SurfaceOverlay`:
 * the surface's box in the browser, and nothing in a static render (the
 * crawlable snapshot renders this layout too, through `SurfaceCore`) — a
 * layer is never part of the page's document. The overlay lets clicks through
 * to the page; a layer's own box takes them back (`pointer-events: auto`).
 */
export function WebsiteLayout() {
  return (
    <div className="h-full min-h-0">
      <AnalyticsTracker app={websiteApp} />
      <Website.Resident.Wrap>
        <FullPane />
      </Website.Resident.Wrap>
      <SurfaceOverlay className="pointer-events-none">
        <Website.Layer.Render />
      </SurfaceOverlay>
    </div>
  );
}
