import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { registerBeforeAfterTool } from "./internal/register-tool";

export default {
  description:
    "Before / after pairs, desktop-only half: the register_before_after MCP tool — captures a route on main and on the conversation's own build through the agent browser (or reads two PNGs the agent made), stores the pair under the agent's tool call and answers its ba id and both images.",
  register: [registerBeforeAfterTool],
} satisfies MachinePluginDefinition;
