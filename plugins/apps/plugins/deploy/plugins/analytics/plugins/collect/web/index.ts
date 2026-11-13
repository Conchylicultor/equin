import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export { AnalyticsTracker } from "./components/analytics-tracker";
export { track } from "./internal/instance";
export {
  setAnalyticsConsent,
  useAnalyticsConsent,
  type AnalyticsConsent,
  type ConsentState,
} from "./internal/consent";
export { observeSectionReach, useSectionReach } from "./internal/section-reach";

export default {
  description:
    "The visit tracker a deployed site mounts, cookieless unless the visitor consents: <AnalyticsTracker app={…} /> records one pageview per path change under that app (landing referrer and utm tags on the first only, the viewport on each) and the visible time on each; on a local serve framed by the Sessions tab's replay, follows its commands (navigate in-app, scroll a section into view); track(name, props?) records a custom event on the current page; useSectionReach(section) / observeSectionReach(el, section) record section_reach once when a section reaches the upper half of the screen, its section prop (<page>/<key>) giving a per-section reach funnel; useAnalyticsConsent() / setAnalyticsConsent(accepted) read and answer the site's consent prompt — accepting keeps a random key in the browser for 13 months, sent with every pageview and event so a return is recognised on any network.",
  contributions: [],
} satisfies PluginDefinition;
