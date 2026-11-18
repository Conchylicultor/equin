import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Reports } from "@plugins/reports/web";
import { CHECK_PASS_HUNG_KIND, CHECK_THREAD_STALL_KIND } from "../core";
import { CheckPassHungSummary } from "./components/check-pass-hung-summary";
import { CheckThreadStallSummary } from "./components/check-thread-stall-summary";

export default {
  description:
    "Check-thread-stall and check-pass-hung report kinds' Debug → Reports summary views: one line naming how long the check thread stalled, its top owner and what it was mostly doing — or, for a hung pass, how long its thread held its core, what was in flight, and that it was killed. Both are filed by the check runner through the report outbox — no collector here.",
  contributions: [
    Reports.KindView({
      match: CHECK_THREAD_STALL_KIND,
      component: CheckThreadStallSummary,
    }),
    Reports.KindView({
      match: CHECK_PASS_HUNG_KIND,
      component: CheckPassHungSummary,
    }),
  ],
} satisfies PluginDefinition;
