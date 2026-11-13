import { FullPane } from "@plugins/layouts/plugins/full-pane/web";
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
 * pages (`Website.Layer`: the consent prompt).
 */
export function WebsiteLayout() {
  return (
    // `relative`: the box a `Website.Layer` contribution pins itself in — the
    // app's surface, so it floats over whichever page scrolls under it.
    <div className="relative h-full min-h-0">
      <AnalyticsTracker app={websiteApp} />
      <FullPane />
      <Website.Layer.Render />
    </div>
  );
}
