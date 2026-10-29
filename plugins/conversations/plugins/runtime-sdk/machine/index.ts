import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { watchConfig } from "@plugins/config_v2/server";
import { Runtime } from "@plugins/conversations/server";
import { Trigger } from "@plugins/infra/plugins/events/server";
import { conversationStatusChanged } from "@plugins/tasks/plugins/tasks-core/server";
import { attemptEndedJob } from "./internal/attempt-ended-job";
import { sdkAgentDaemon } from "./internal/agent-process";
import { agentProcessesServed } from "./internal/agent-processes";
import { sdkBundledCliServed } from "./internal/bundled-cli";
import { requestDisclaimHelper } from "./internal/disclaim";
import { claudeUsageServed } from "./internal/claude-usage";
import { sdkEventsWatcher } from "./internal/consumer";
import {
  sdkCatchUpOverdueKind,
  sdkConsumerStalledKind,
  turnUnknownIdKind,
  turnWithoutIdKind,
} from "./internal/report-kinds";
import { sdkRuntime } from "./internal/sdk-runtime";
import {
  handleRefreshClaudeUsage,
  startUsageOnProbe,
  stopUsageOnProbe,
} from "./internal/usage-probe";
import {
  autoResumeConfig,
  refreshClaudeUsage,
  resumeStoppedConversations,
} from "../core";
import { autoResumeJob, requestAutoResume } from "./internal/auto-resume";
import { handleResumeStopped } from "./internal/resume-stopped";

export default {
  description:
    "The sdk runtime's desktop half: the `sdk` ConversationRuntime — one Agent SDK process per conversation (bin/agent.ts), started detached (a runtime-sdk.agent daemon instance, followed by its pid file, re-attached after a restart) so it outlives the backend, its paths under this backend's namespace, commanded over its Unix socket (turn, interrupt, answer, dismiss, shutdown; liveness is `hello`), with Stop as interrupt + a rewinding relaunch, claude run through the disclaim-exec helper (packages/spawn-disclaim, requested at boot, resolved at every start) so macOS attributes its permission prompts to claude, spawned as a hardlink named for the conversation (<title> · <conv-id>) so a prompt says which agent asks and each conversation's grants are its own — and the consumer that tails each agent's events.jsonl (one kqueue watch, rotation-aware, from the cursor in conversations_ext_sdk_agent) into the conversation's status, the turn ledger and the question relay — each catch-up watched (an sdk-catch-up-overdue report past 30 s, naming the step it is parked in), and a launch whose agent answers while its started line was never applied reported as sdk-consumer-stalled, and each turn the agent took confirmed in the ledger by the turn id it echoed (an id-less turn from an agent that puts ids on every turn reported as turn-without-id, an id the ledger does not hold as turn-unknown-id); the runtime-sdk.bundled-cli live value (the installed SDK's version and the CLI version it was built for); the runtime-sdk.agent-processes live value (the agent processes running here and in every other namespace, from their pid files); the runtime-sdk.claude-usage live value (the subscription's session and weekly limits as the machine's agents last reported them, from the one usage file they overwrite, or read on demand — POST /api/claude-usage/refresh and after every Claude Code probe — through the SDK's get_usage control request, no model call); and, when an attempt's last conversation is closed, stopping the agents its worktree's backend launched; the resume-stopped endpoint (a resume turn to each conversation an API error stopped — a usage limit, a server error, a lost connection — whose agent the send first restarts on an account with room when a usage limit stopped it); and auto-resume (with Resume agents when their usage limit resets on, the runtime-sdk.auto-resume job sends that turn to every agent a usage limit stopped once the account a launch picks has room — enqueuing itself at the limit's reset while agents still wait).",
  httpRoutes: {
    [refreshClaudeUsage.route]: handleRefreshClaudeUsage,
    [resumeStoppedConversations.route]: handleResumeStopped,
  },
  register: [
    Runtime.define(sdkRuntime),
    sdkEventsWatcher,
    sdkAgentDaemon,
    attemptEndedJob,
    autoResumeJob,
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
    sdkConsumerStalledKind,
    sdkCatchUpOverdueKind,
    turnWithoutIdKind,
    turnUnknownIdKind,
  ],
  onReady: () => {
    startUsageOnProbe();
    // Fires at once too: the agents a limit stopped while this backend was
    // down, or before the setting was turned on, are planned for here.
    watchConfig(autoResumeConfig, () => {
      void requestAutoResume();
    });
    // Off the boot path: one readyNow, then (when not installed) a
    // `deps.install` job — the helper is ready before the first agent needs it.
    void requestDisclaimHelper();
  },
  onShutdown: () => {
    stopUsageOnProbe();
  },
} satisfies MachinePluginDefinition;
