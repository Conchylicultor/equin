import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { SiteTabs } from "@plugins/apps/plugins/deploy/plugins/deployments/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import {
  SessionsSection,
  useSessionsAvailable,
} from "./components/sessions-section";

export default {
  description:
    "Sessions tab of a site's page, shown only when the deployment's composition ships the collect plugin: one row per anonymous visit (country, time, device and software, source, first visit or returning, channel), its journey on a shared log time axis (pages split by their share of the visit, the read line and section ticks, action icons, each named on hover) with its duration and actions; opening a row shows its timeline (each page, the sections reached and when, the actions in order, the exit). Range, shape switch with per-shape counts, search over the loaded visits; read over SSH as key-range pages that load as the list scrolls.",
  contributions: [
    SiteTabs.View({
      id: "sessions",
      title: "Sessions",
      icon: symbol("timeline"),
      component: SessionsSection,
      useAvailable: useSessionsAvailable,
    }),
  ],
} satisfies PluginDefinition;
