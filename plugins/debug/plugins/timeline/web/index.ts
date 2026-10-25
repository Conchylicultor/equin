import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { SlowEvents } from "@plugins/debug/plugins/trace/plugins/pane/web";
import { TimelineView } from "./components/timeline-view";
import { symbol } from "@plugins/ui/plugins/icons/core";

export default {
  description:
    "Timeline tab for the Slow Events pane: the unified cross-worktree wall-clock Gantt — per-worktree lanes of traces / slow-ops / reports / builds / boots with health heat strips and cross-worktree incident bands, read live from the debug.timeline.scan value as the fan-out resolves.",
  contributions: [
    SlowEvents.View({
      id: "timeline",
      title: "Timeline",
      icon: symbol("timeline"),
      order: 40,
      component: TimelineView,
    }),
  ],
} satisfies PluginDefinition;
