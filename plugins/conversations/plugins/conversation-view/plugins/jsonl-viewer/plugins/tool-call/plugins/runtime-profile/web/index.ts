import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { JsonlViewerTool } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/web";
import { RuntimeProfileToolView } from "./components/runtime-profile-tool-view";

export default {
  description:
    "Renders get_runtime_profile MCP tool calls: the target worktree, kind and limit in the summary, and the slowest routes, queries and loaders as one compact table per span kind.",
  contributions: [
    JsonlViewerTool.Renderer({
      match: /get_runtime_profile$/,
      component: RuntimeProfileToolView,
    }),
  ],
} satisfies PluginDefinition;
