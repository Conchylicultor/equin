import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Reports } from "@plugins/reports/web";
import { BUILD_FAILED_KIND } from "../core";
import { BuildFailedSummary } from "./components/build-failed-summary";

export default {
  description:
    "Build-failed report kind's Debug → Reports summary view: one line naming the step main's build failed in and its failing checks or error line.",
  contributions: [
    Reports.KindView({
      match: BUILD_FAILED_KIND,
      component: BuildFailedSummary,
    }),
  ],
} satisfies PluginDefinition;
