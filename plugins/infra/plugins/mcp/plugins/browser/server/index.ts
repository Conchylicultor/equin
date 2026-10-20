import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { Trigger } from "@plugins/infra/plugins/events/server";
import { conversationStatusChanged } from "@plugins/tasks/plugins/tasks-core/server";
import { browserTools } from "./internal/tools";
import { browserConversationEndedJob } from "./internal/conversation-ended";
import {
  agentBrowserHostDaemon,
  agentBrowserStatusServed,
  agentBrowserStatusWatcher,
  agentBrowserUsageServed,
  startStatusWatcher,
  stopStatusWatcher,
} from "./internal/host-client";

export default {
  description:
    "Agent browser: MCP tools (browser_navigate, browser_read_page, browser_act, browser_batch, browser_screenshot, browser_console, …) forwarded to one detached host process per machine that owns the shared headless Chromium — an isolated session per conversation targeted at that conversation's own worktree build, tabs that stay open across calls and across backend restarts, frozen between calls — plus the agent-browser.status value (host, sessions, tabs, deadlines) pushed from the host's status file, and the agent-browser.usage value (the host's and Chromium's CPU and memory by process role) sampled on subscribe.",
  contributions: [
    Trigger({
      on: conversationStatusChanged,
      do: browserConversationEndedJob,
      with: {},
      oneShot: false,
    }),
    ...agentBrowserStatusServed.declare,
    ...agentBrowserUsageServed.declare,
  ],
  register: [
    ...browserTools,
    browserConversationEndedJob,
    agentBrowserHostDaemon,
    agentBrowserStatusWatcher,
  ],
  onReady: startStatusWatcher,
  onShutdown: stopStatusWatcher,
} satisfies ServerPluginDefinition;
