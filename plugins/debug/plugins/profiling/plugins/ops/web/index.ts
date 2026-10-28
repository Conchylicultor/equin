import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Profiling } from "@plugins/debug/plugins/profiling/web";
import { Pane } from "@plugins/primitives/plugins/pane/web";
import { OpSection } from "./components/op-section";
import { opDetailPane } from "./panes";

export { opDetailPane } from "./panes";
export { WorktreeOpGantt } from "./components/worktree-op-gantt";

export default {
  description:
    "Op contention profiling for the Gantt debug pane: the Profiling section hosting the unified build/push/check/test/e2e Gantt over the live op-store history (last 24 h), the per-worktree Gantt (its ops ± 20 min of everything around them), and the op detail pane (with every op in the repo around it) — all computed client-side from opsHistory rows.",
  contributions: [
    Profiling.Section({
      id: "ops",
      order: 3,
      component: OpSection,
    }),
    Pane.Register({ pane: opDetailPane }),
  ],
  slots: { "debug-profiling-op-detail": opDetailPane },
} satisfies PluginDefinition;
