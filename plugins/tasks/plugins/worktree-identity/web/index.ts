import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { HealthReport } from "@plugins/shell/plugins/health-report/web";
import { WorktreeActions } from "./components/worktree-actions";
import { useWorktreeIdentity } from "./internal/use-worktree-identity";
import { symbol } from "@plugins/ui/plugins/icons/core";

export default {
  description:
    "Which checkout and task this page is served from, as the health report's first (informational) row: titled by the kind of checkout (Main checkout / Agent worktree / <Composition> worktree / Local dev), the namespace or the task's short title and checkout below, a copy button, and Open task.",
  contributions: [
    HealthReport.Row({
      kind: "info",
      id: "worktree",
      icon: symbol("account-tree"),
      useInfo: useWorktreeIdentity,
      actions: WorktreeActions,
    }),
  ],
} satisfies PluginDefinition;
