import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Pane } from "@plugins/primitives/plugins/pane/web";
import { DebugApp } from "@plugins/apps/plugins/debug/plugins/shell/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { backgroundEntryPane, backgroundPane } from "./panes";

// The entry detail pane, for a surface that links to one entry (Debug → Queue
// opens a job's entry from its detail).
export { backgroundEntryPane } from "./panes";

export default {
  description:
    "Debug → Background activity: the list pane over the background catalog (everything this backend and the central runtime run on their own) and a detail pane per entry, with the Debug sidebar entry.",
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
