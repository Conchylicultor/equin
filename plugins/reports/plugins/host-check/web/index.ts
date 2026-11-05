import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Reports } from "@plugins/reports/web";
import { HOST_CHECK_KIND } from "../core";
import { HostCheckSummary } from "./components/host-check-summary";

export default {
  description:
    "Host-check report kind's Debug → Reports summary view: one line naming the failing host-scoped check and the first line of its message. Filed by main's hourly host audit through the report outbox — no collector here.",
  contributions: [
    Reports.KindView({
      match: HOST_CHECK_KIND,
      component: HostCheckSummary,
    }),
  ],
} satisfies PluginDefinition;
