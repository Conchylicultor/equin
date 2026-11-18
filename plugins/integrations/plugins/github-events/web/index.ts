import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Reports } from "@plugins/reports/web";
import { HealthReport } from "@plugins/shell/plugins/health-report/web";
import { GITHUB_RUN_FAILED_KIND } from "../core";
import { GitHubRunFailedSummary } from "./components/run-failed-summary";
import { useGitHubEventsHealth } from "./internal/use-github-events-health";

export default {
  description:
    "GitHub events in the browser: the health report's GitHub events row (on the publisher's main only — absent elsewhere): connected once GitHub pinged every watched repo's forwarder, pulsing while one connects, attention while one reconnects or gave up (naming why) or while forwarding is not set up (with the command that sets it up); and the github-run-failed report kind's Debug → Reports summary line.",
  contributions: [
    HealthReport.Row({
      kind: "status",
      id: "github-events",
      title: "GitHub events",
      useStatus: useGitHubEventsHealth,
    }),
    Reports.KindView({
      match: GITHUB_RUN_FAILED_KIND,
      component: GitHubRunFailedSummary,
    }),
  ],
} satisfies PluginDefinition;
