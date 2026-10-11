import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Pane } from "@plugins/primitives/plugins/pane/web";
import { DebugApp } from "@plugins/apps/plugins/debug/plugins/shell/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { backgroundEntryPane, backgroundPane } from "./panes";

// For a surface that shows one entry it knows by (kind, name) — an automation
// showing its own job's next run and Run now: the entry read across both halves
// of the catalog, and the countdown to a scheduled run.
export { useEntry as useBackgroundEntry } from "./internal/use-entries";
export { NextRun } from "./components/next-run";
// The entry detail pane, for a surface that links to one entry (Debug → Queue
// opens a job's entry from its detail).
export { backgroundEntryPane } from "./panes";

export default {
  description:
    "Debug → Background activity: a DataView over the pushed background.catalog — everything this backend runs on its own, grouped by kind, with a status dot, the trigger in words and its next run, and the last run — and a detail pane per entry with its scope, declaring plugin, recent runs and Run now.",
  contributions: [
    Pane.Register({ pane: backgroundPane }),
    Pane.Register({ pane: backgroundEntryPane }),
    DebugApp.Sidebar({
      id: "background",
      title: "Background activity",
      icon: symbol("schedule"),
      opens: { pane: backgroundPane, params: {} },
    }),
  ],
  slots: {
    background: backgroundPane,
    backgroundEntry: backgroundEntryPane,
  },
} satisfies PluginDefinition;
