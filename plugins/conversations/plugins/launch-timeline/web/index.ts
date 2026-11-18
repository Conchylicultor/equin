import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Profiling } from "@plugins/debug/plugins/profiling/web";
import { LaunchesSection } from "./internal/launches-section";

export default {
  description:
    "Agent launches in Debug → Profiling: per-stretch p50 / p90 of the newest launch records (request → spawn → checkout child start, boot, checkout → agent started → CLI ready → first token → first message, and the totals), split by spare / fresh checkout, and each checkout step's.",
  contributions: [
    Profiling.Section({
      id: "launches",
      order: 4,
      component: LaunchesSection,
    }),
  ],
} satisfies PluginDefinition;
