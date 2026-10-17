import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { Trigger } from "@plugins/infra/plugins/events/server";
import { conversationStatusChanged } from "@plugins/tasks/plugins/tasks-core/server";
import { browserTools } from "./internal/tools";
import { browserConversationEndedJob } from "./internal/conversation-ended";

export default {
  description:
    "Agent browser: MCP tools (browser_navigate, browser_read_page, browser_act, browser_batch, browser_screenshot, browser_console, …) driving one shared headless Chromium, with an isolated session per conversation targeted at that conversation's own worktree build and tabs that stay open across calls.",
  contributions: [
    Trigger({
      on: conversationStatusChanged,
      do: browserConversationEndedJob,
      with: {},
      oneShot: false,
    }),
  ],
  register: [...browserTools, browserConversationEndedJob],
} satisfies ServerPluginDefinition;
