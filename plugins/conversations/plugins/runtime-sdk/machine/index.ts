import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { Runtime } from "@plugins/conversations/server";
import { Trigger } from "@plugins/infra/plugins/events/server";
import { conversationStatusChanged } from "@plugins/tasks/plugins/tasks-core/server";
import { attemptEndedJob } from "./internal/attempt-ended-job";
import { sdkAgentDaemon } from "./internal/agent-process";
import { agentProcessesServed } from "./internal/agent-processes";
import { sdkBundledCliServed } from "./internal/bundled-cli";
import { claudeUsageServed } from "./internal/claude-usage";
import { sdkEventsWatcher } from "./internal/consumer";
import { sdkRuntime } from "./internal/sdk-runtime";
import {
  handleRefreshClaudeUsage,
  startUsageOnProbe,
  stopUsageOnProbe,
} from "./internal/usage-probe";
import { refreshClaudeUsage } from "../core";

export default {
  description:
    "The sdk runtime's desktop half: the `sdk` ConversationRuntime — one Agent SDK process per conversation (bin/agent.ts), started detached (a runtime-sdk.agent daemon instance, followed by its pid file, re-attached after a restart) so it outlives the backend, its paths under this backend's namespace, commanded over its Unix socket (turn, interrupt, answer, dismiss, shutdown; liveness is `hello`), with Stop as interrupt + a rewinding relaunch — and the consumer that tails each agent's events.jsonl (one kqueue watch, rotation-aware, from the cursor in conversations_ext_sdk_agent) into the conversation's status, the turn ledger and the question relay; the runtime-sdk.bundled-cli live value (the installed SDK's version and the CLI version it was built for); the runtime-sdk.agent-processes live value (the agent processes running here and in every other namespace, from their pid files); the runtime-sdk.claude-usage live value (the subscription's session and weekly limits as the machine's agents last reported them, from the one usage file they overwrite, or read on demand — POST /api/claude-usage/refresh and after every Claude Code probe — through the SDK's get_usage control request, no model call); and, when an attempt's last conversation is closed, stopping the agents its worktree's backend launched.",
  httpRoutes: {
    [refreshClaudeUsage.route]: handleRefreshClaudeUsage,
  },
  register: [
    Runtime.define(sdkRuntime),
    sdkEventsWatcher,
    sdkAgentDaemon,
    attemptEndedJob,
  ],
  contributions: [
    Trigger({
      on: conversationStatusChanged,
      do: attemptEndedJob,
      with: {},
      oneShot: false,
    }),
    ...sdkBundledCliServed.declare,
    ...agentProcessesServed.declare,
    ...claudeUsageServed.declare,
  ],
  onReady: () => {
    startUsageOnProbe();
  },
  onShutdown: () => {
    stopUsageOnProbe();
  },
} satisfies MachinePluginDefinition;
