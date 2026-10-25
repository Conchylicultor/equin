import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { SlowEvents } from "@plugins/debug/plugins/trace/plugins/pane/web";
import { ClusterView } from "./components/cluster-view";
import { symbol } from "@plugins/ui/plugins/icons/core";

export default {
  description:
    "Cross-worktree Cluster tab for the Slow Events pane: fans out across every worktree DB fork and merges them into one aggregate + a unified contention timeline.",
  contributions: [
    SlowEvents.View({
      id: "cluster",
      title: "Cluster",
      icon: symbol("hub"),
      component: ClusterView,
    }),
  ],
} satisfies PluginDefinition;
