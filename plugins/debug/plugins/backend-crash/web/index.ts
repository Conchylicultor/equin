import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Reports } from "@plugins/reports/web";
import { BackendCrashSummary } from "./components/backend-crash-summary";

export default {
  collapsed: true,
  description:
    "Backend-crash report renderer: a one-line Debug → Reports summary for the backend-crash kind (worktree, signal, uptime, Bun's panic line).",
  contributions: [
    Reports.KindView({
      match: "backend-crash",
      component: BackendCrashSummary,
    }),
  ],
} satisfies PluginDefinition;
