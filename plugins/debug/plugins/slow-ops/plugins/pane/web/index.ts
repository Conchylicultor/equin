import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Pane } from "@plugins/primitives/plugins/pane/web";
import { SlowEvents } from "@plugins/debug/plugins/trace/plugins/pane/web";
import { SlowOpsView } from "./components/slow-ops-view";
import { slowOpDetailPane } from "./panes";
import { symbol } from "@plugins/ui/plugins/icons/core";

// The per-worktree ranked slow-op aggregate — no longer its own sidebar pane.
// It contributes as the **Aggregates** tab of the unified Debug → Slow Events
// pane (owned by trace/pane), alongside the trace Events list and the Cluster
// tab, plus the per-op detail pane a row opens. Import direction: slow-ops →
// trace/pane (slot token); trace never imports slow-ops, so the graph stays
// acyclic.
export default {
  description:
    "Aggregates tab of the Slow Events pane: a live, paged ranking of slow operations, and the per-operation detail pane (callers, waits, variants, measures, recent samples).",
  contributions: [
    SlowEvents.View({
      id: "aggregates",
      title: "Aggregates",
      icon: symbol("computer"),
      order: 20,
      component: SlowOpsView,
    }),
    Pane.Register({ pane: slowOpDetailPane }),
  ],
  slots: {
    "slow-op-detail": slowOpDetailPane,
  },
} satisfies PluginDefinition;
