import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Pane } from "@plugins/primitives/plugins/pane/web";
import { DebugApp } from "@plugins/apps/plugins/debug/plugins/shell/web";
import { logsPane, logChannelPane } from "./panes";
import { symbol } from "@plugins/ui/plugins/icons/core";

export { logsPane, logChannelPane } from "./panes";

export default {
  description:
    "Debug → Logs: every log of a worktree (what it records, its size against its rotation bound, its kept files) and a reader that pages one log back across its rotations, opened from the Debug sidebar or by a link naming a worktree, a log and an instant.",
  contributions: [
    Pane.Register({ pane: logsPane }),
    Pane.Register({ pane: logChannelPane }),
    DebugApp.Sidebar({
      id: "logs",
      title: "Logs",
      icon: symbol("terminal"),
      opens: { pane: logsPane, params: {} },
    }),
  ],
  slots: { logs: logsPane, "logs-channel": logChannelPane },
} satisfies PluginDefinition;
