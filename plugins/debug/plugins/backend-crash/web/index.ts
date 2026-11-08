import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Reports } from "@plugins/reports/web";
import { BackendCrashSummary } from "./components/backend-crash-summary";
import { BackendCrashLoopSummary } from "./components/backend-crash-loop-summary";
import { BackendExitSummary } from "./components/backend-exit-summary";

export default {
  collapsed: true,
  description:
    "Backend death report renderers: one-line Debug → Reports summaries for backend-crash (worktree, signal, uptime, Bun's panic line), backend-exit (worktree, exit code, booting or how long after ready) and backend-crash-loop (worktree, deaths and span, causes, looping or ended).",
  contributions: [
    Reports.KindView({
      match: "backend-crash",
      component: BackendCrashSummary,
    }),
    Reports.KindView({
      match: "backend-exit",
      component: BackendExitSummary,
    }),
    Reports.KindView({
      match: "backend-crash-loop",
      component: BackendCrashLoopSummary,
    }),
  ],
} satisfies PluginDefinition;
