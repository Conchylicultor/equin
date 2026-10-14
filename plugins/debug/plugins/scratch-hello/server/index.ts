import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { ScratchProfile } from "@plugins/conversations/plugins/workspace/server";
import { scratchHelloProfile } from "./internal/profile";
import { scratchHelloWhereTool } from "./internal/mcp-tools";

export default {
  description:
    "Debug scratch profile `scratch.hello`: a minimal scratch agent (a note file, one profile-only MCP tool, flag_raise) for checking what a scratch workspace's agent receives.",
  register: [ScratchProfile.define(scratchHelloProfile), scratchHelloWhereTool],
} satisfies ServerPluginDefinition;
