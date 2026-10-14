import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { Workspace } from "@plugins/conversations/plugins/workspace/server";
import { scratchWorkspace } from "./internal/scratch-workspace";
import { scratchMcpScope } from "./internal/mcp-scope";
import { scratchReapJob } from "./internal/reap-job";
import { trustScratchRoot } from "./internal/trust-root";

export default {
  description:
    "The scratch workspace: a conversation runs in a plain directory (`state/workspaces/<attemptId>`) holding only its scratch profile's CLAUDE.md and inputs — no git, DB fork or build. Launched with the user's own settings, the app's MCP server scoped to the profile's tool allowlist, and the profile's permissions; reaped a week after its task is done or dropped.",
  register: [
    Workspace.define(scratchWorkspace),
    scratchMcpScope,
    scratchReapJob,
  ],
  // Before any scratch spawn can run: an untrusted root would hold every
  // scratch session at Claude Code's trust dialog (`prepare` asserts it).
  onReady: async () => {
    trustScratchRoot();
  },
} satisfies ServerPluginDefinition;
