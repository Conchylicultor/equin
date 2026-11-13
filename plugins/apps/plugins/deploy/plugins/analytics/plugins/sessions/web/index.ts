import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { SiteTabs } from "@plugins/apps/plugins/deploy/plugins/deployments/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Pane } from "@plugins/primitives/plugins/pane/web";
import { replayPane } from "./components/replay-pane";
import {
  SessionsSection,
  SessionsSources,
  VisitsSource,
  useSessionsAvailable,
} from "./components/sessions-section";

export default {
  description:
    "Sessions tab of a site's page, shown only when the deployment's composition ships the collect plugin: one row per anonymous visit (country, time, device and software, source, first visit or returning, channel), its journey on a shared log time axis (pages split by their share of the visit, the read line and section ticks, action icons, each named on hover) with its duration and actions; opening a row shows its timeline (each page, the sections reached and when, the actions in order, the exit), and clicking a page — or Replay — opens the visit replayed on the site's local serve (replay/:deploymentId/:visitId/:page?): at the visitor's viewport, its recorded load as a veil, pages opened in-app, sections scrolled to when reached, actions as toasts, stretches away dimmed or skipped, with a scrubber, speeds and a step list. Read from this computer's copy of the site's analytics (site-mirror, its freshness line above the list; loading until a first whole copy is in place) as live key-range pages: the views (All / With actions / 2+ pages / Bounced) are saved filters, and every filter — whose visits, the device, any field — runs on the copy, a narrowed view carried in the URL.",
  slots: { sources: SessionsSources, "deploy-session-replay": replayPane },
  contributions: [
    Pane.Register({ pane: replayPane }),
    SiteTabs.View({
      id: "sessions",
      title: "Sessions",
      icon: symbol("timeline"),
      component: SessionsSection,
      useAvailable: useSessionsAvailable,
    }),
    SessionsSources({
      id: "visits",
      title: "Visits",
      icon: symbol("timeline"),
      views: ["list"],
      component: VisitsSource,
    }),
  ],
} satisfies PluginDefinition;
