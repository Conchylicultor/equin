import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { SiteBanner } from "@plugins/apps/plugins/deploy/plugins/deployments/web";
import { investigateDeployFailures } from "./components/investigate-failure-action";
import { useFailureBanner } from "./components/failure-banner";
import { SiteLive } from "@plugins/apps/plugins/deploy/plugins/box-link/plugins/site-row/web";
import {
  SiteInvestigateAction,
  SiteInvestigateActionExhibit,
} from "./components/site-live-investigate";

export default {
  description:
    "Contributes the site page's failure banner (the newest run failed: its leg, the CLI's message verbatim, what the box still serves, Investigate) and the investigate row action to every failed run in a site's Deployments tab, launching an agent briefed on that failure (also offered on the health report's deployed-site row while its latest run failed) — the CLI's own message verbatim, the run's identity and pinned bundle, and where the transcript is.",
  contributions: [
    // The site page's banner while its newest run is a failure.
    SiteBanner({ id: "failed", useBanner: useFailureBanner }),
    investigateDeployFailures,
    // The health report's site row: Investigate while its latest run failed.
    SiteLive.Action({
      id: "investigate",
      component: SiteInvestigateAction,
      exhibit: SiteInvestigateActionExhibit,
    }),
  ],
} satisfies PluginDefinition;
