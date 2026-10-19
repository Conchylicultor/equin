import type { LaunchFragment } from "@plugins/conversations/plugins/workspace/server";
import type { LaunchHooks } from "@plugins/conversations/plugins/agent-launch/server";
import {
  LAUNCH_CLI_SETTINGS,
  mergeLaunchSettings,
} from "@plugins/conversations/plugins/agent-launch/server";
import {
  cliFlagFor,
  type ConversationModel,
} from "@plugins/conversations/plugins/model-provider/core";
import {
  resolveEffortFlag,
  resolveEffortSettings,
  type EffortLevel,
} from "@plugins/conversations/plugins/effort-provider/core";
import type { AgentLaunchOptions } from "../../core";

/** The CLI's own default when a workspace names no sources: all of them. */
const DEFAULT_SETTING_SOURCES = ["user", "project", "local"] as const;

export interface SdkLaunchInput {
  cwd: string;
  claudeBin: string;
  launch: LaunchFragment;
  /** The hooks every runtime runs with (`agentLaunchHooks()`). */
  hooks: LaunchHooks;
  model?: ConversationModel;
  effort?: EffortLevel;
  resumeSessionId?: string;
  forkSession?: boolean;
  prompt?: string;
}

/**
 * The agent's launch options for one `create`: the workspace's typed fragment
 * mapped onto the SDK's own options one to one (where tmux renders it to argv),
 * and the launch's one settings object — the thinking mode, the fixed CLI
 * preferences, the hooks every runtime runs with and the workspace's fragment,
 * merged so a key two of them set throws. Unlike tmux there are no hooks of
 * this runtime's own: turns are confirmed by the agent's `turn_started` event
 * and questions held in `canUseTool`.
 */
export function sdkLaunchOptions(input: SdkLaunchInput): AgentLaunchOptions {
  const { launch } = input;
  return {
    cwd: input.cwd,
    claudeBin: input.claudeBin,
    model: input.model ? cliFlagFor(input.model) : null,
    effort: (input.effort && resolveEffortFlag(input.effort)) ?? null,
    settings: mergeLaunchSettings(
      input.effort ? resolveEffortSettings(input.effort) : undefined,
      LAUNCH_CLI_SETTINGS,
      { hooks: input.hooks },
      launch.settings,
    ),
    settingSources: [...(launch.settingSources ?? DEFAULT_SETTING_SOURCES)],
    mcpServers: launch.mcpServers ? { ...launch.mcpServers } : null,
    strictMcpConfig: launch.strictMcpConfig ?? false,
    resume: input.resumeSessionId ?? null,
    resumeAt: null,
    resumeDropsTurn: null,
    fork: input.forkSession ?? false,
    sessionId: launchSessionId(input.resumeSessionId, input.forkSession),
    prompt: input.prompt && input.prompt.length > 0 ? input.prompt : null,
  };
}

/**
 * The session a launch runs under: the resumed one, or — a fork or a fresh
 * start — a new id the agent passes the SDK as `sessionId`.
 */
function launchSessionId(
  resumeSessionId: string | undefined,
  forkSession: boolean | undefined,
): string {
  return resumeSessionId && !forkSession
    ? resumeSessionId
    : crypto.randomUUID();
}

/**
 * The options that relaunch a stopped agent with its last turn taken back out
 * of the session: the same launch, resumed at the message before the turn,
 * the turn dropped — the transcript gains a branch, never a truncation under
 * a live CLI. No anchor (the turn was the session's first): a fresh session.
 */
export function rewindRelaunchOptions(
  previous: AgentLaunchOptions,
  rewind: { sessionId: string; anchorUuid: string | null; promptUuid: string },
): AgentLaunchOptions {
  const base = { ...previous, fork: false, prompt: null };
  if (rewind.anchorUuid === null) {
    return {
      ...base,
      resume: null,
      resumeAt: null,
      resumeDropsTurn: null,
      sessionId: crypto.randomUUID(),
    };
  }
  return {
    ...base,
    sessionId: rewind.sessionId,
    resume: rewind.sessionId,
    resumeAt: rewind.anchorUuid,
    resumeDropsTurn: rewind.promptUuid,
  };
}
