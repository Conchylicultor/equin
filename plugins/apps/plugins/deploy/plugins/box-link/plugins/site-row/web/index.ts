import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { HealthReport } from "@plugins/shell/plugins/health-report/web";
import { SiteLive } from "./slots";
import { SiteDetail, SiteGlance, useSiteRows } from "./components/site-row";
import {
  ServerSection,
  ServerSectionExhibit,
} from "./components/server-section";
import { OpenSiteAction, RetryAction } from "./components/site-actions";

export { SiteLive } from "./slots";
export type {
  SiteExhibitState,
  SiteLiveExhibitProps,
  SiteLivePart,
  SiteLiveProps,
} from "./slots";
// The frame every body section draws through, and the freshness every part
// showing the box's numbers dims by — so the parts of one row agree.
export { SiteLiveAside, SiteLiveBlock } from "./components/site-block";
export { siteFreshness } from "./internal/status";
export type { SiteFreshness } from "./internal/status";

export default {
  description:
    "The health report's deployed-site rows: one row per deployment from deploy.site-health (titled by its hostname; ok while live and up to date, info (blue) while behind main, info and transitioning while deploying, attention while reconnecting, after a failed deploy or with a release too old for the link, critical while down, unreachable or refused), and its body — the alert (what is wrong, in one sentence) over blocks — drawn from three render slots the owning plugins contribute to — SiteLive.Glance (the title line's figure), SiteLive.Section (body blocks) and SiteLive.Action (the footer's controls), each told the deployment and its health. Contributes its own Server block (CPU / memory / disk from the last heartbeat, uptime or last heard, dimmed when stale), Retry now and Open site.",
  contributions: [
    HealthReport.Row({
      kind: "set",
      id: "sites",
      title: "Deployed sites",
      useRows: useSiteRows,
      actions: SiteGlance,
      component: SiteDetail,
    }),
    SiteLive.Section({
      id: "server",
      component: ServerSection,
      exhibit: ServerSectionExhibit,
    }),
    SiteLive.Action({ id: "retry", component: RetryAction }),
    SiteLive.Action({ id: "open-site", component: OpenSiteAction }),
  ],
  slots: SiteLive,
} satisfies PluginDefinition;
