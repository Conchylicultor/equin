import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Pane } from "@plugins/primitives/plugins/pane/web";
import { DebugApp } from "@plugins/apps/plugins/debug/plugins/shell/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { mcpToolPane, mcpToolsPane } from "./panes";

export default {
  description:
    "Debug → MCP tools: every tool the MCP server hosts as a live DataView (searchable over name, declaring plugin and description; filterable by plugin, visibility and live description), with a detail pane per tool — declaring plugin, the name agents call it by, who it is listed for (every conversation, gated by when, or reserved for scratch profiles), the full description, its arguments and the input schema exactly as tools/list sends it — plus the server instructions sections and scope resolver above the list.",
  contributions: [
    Pane.Register({ pane: mcpToolsPane }),
    Pane.Register({ pane: mcpToolPane }),
    DebugApp.Sidebar({
      id: "mcp-tools",
      title: "MCP tools",
      icon: symbol("build"),
      opens: { pane: mcpToolsPane, params: {} },
    }),
  ],
  slots: {
    mcpTools: mcpToolsPane,
    mcpTool: mcpToolPane,
  },
} satisfies PluginDefinition;
