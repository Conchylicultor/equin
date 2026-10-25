import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { HealthReport } from "@plugins/shell/plugins/health-report/web";
import { WorktreeActions } from "./components/worktree-actions";
import { useWorktreeIdentity } from "./internal/use-worktree-identity";
import { symbol } from "@plugins/ui/plugins/icons/core";

export default {
  description:
    "Which checkout and task this page is served from, as the health report's first (informational) row: the linked task's title or the namespace, the kind of place it names, a copy button, and Open task.",
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
