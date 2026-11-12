import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { JsonlViewerTool } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/web";
import { QueryDbToolView } from "./components/query-db-tool-view";

export default {
  description:
    "Renders query_db MCP tool calls: the SQL on one line (highlighted inside), the database when one was named, the row count in the note, and the rows as a compact table; a failed query turns the card to its error tone with the database's message.",
  contributions: [
    JsonlViewerTool.Renderer({
      match: /query_db$/,
      icon: symbol("database"),
      component: QueryDbToolView,
    }),
  ],
} satisfies PluginDefinition;
