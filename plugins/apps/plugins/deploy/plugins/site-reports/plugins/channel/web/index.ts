import {
  Core,
  type PluginDefinition,
} from "@plugins/framework/plugins/web-sdk/core";
import { reportChannel } from "@plugins/reports/web";
import { siteReportChannel } from "./internal/channel";

export { countPageDrop } from "./internal/channel";
import { FlushReportsOnPagehide } from "./components/flush-on-pagehide";

export default {
  description:
    "The website's report channel: registers itself as reports' reportChannel at register time, so report() on a site page — the page's collectors, which also catch what the live demo raises — sends to the site's own public intake (POST /api/site-reports) instead of a reports engine the site does not have: deduped by fingerprint (a repeat only counted), at most 20 fingerprints and 10 POSTs per visit, batched 5 s, backed off on failure (stopping after 5), anonymous (no client id or user agent, the pathname only, fitted to the intake's bounds — an oversized report trimmed and saying so, never dropped — and a batch kept under its body bound). Excluded from every composition by default (base-exclusions); the website names it.",
  register: [
    {
      register() {
        reportChannel.register(siteReportChannel);
      },
    },
  ],
  contributions: [
    Core.Root({ component: FlushReportsOnPagehide, scope: "page" }),
  ],
} satisfies PluginDefinition;
