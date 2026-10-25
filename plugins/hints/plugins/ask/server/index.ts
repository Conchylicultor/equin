import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { ConfigV2 } from "@plugins/config_v2/server";
import { askConfig } from "../core";
import { fileTaskTool } from "./internal/tools";

export default {
  description:
    "Ask equin, server half: the help agent's reserved ask_file_task tool (a task with no folder or dependency edges, in the default worktree workspace, filed under Improvements and armed with the configured model so it launches at once), and the Ask equin config (the answering model, the filed tasks' model, the guidance added to the help agent's prompt).",
  contributions: [ConfigV2.Register({ descriptor: askConfig })],
  register: [fileTaskTool],
} satisfies ServerPluginDefinition;
