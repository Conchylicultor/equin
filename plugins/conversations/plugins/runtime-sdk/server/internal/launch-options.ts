import type {
  LaunchFragment,
  LaunchPermissions,
} from "@plugins/conversations/plugins/workspace/server";
import type { LaunchPolicy } from "@plugins/conversations/plugins/agent-launch/server";
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
import type { AgentLaunchIntent, AgentLaunchPrompt } from "../../core";

/** The CLI's own default when a workspace names no sources: all of them. */
const DEFAULT_SETTING_SOURCES = ["user", "project", "local"] as const;

export interface SdkLaunchInput {
  cwd: string;
  launch: LaunchFragment;
  /** What every runtime launches with (`agentLaunchPolicy()`). */
  policy: LaunchPolicy;
  model?: ConversationModel;
  effort?: EffortLevel;
  resumeSessionId?: string;
  forkSession?: boolean;
  /** The first turn: its ledger id and text. */
  prompt?: AgentLaunchPrompt;
  appendSystemPrompt?: string;
}

/**
 * The agent's launch options for one `create`: the workspace's typed fragment
 * mapped onto the SDK's own options one to one (where tmux renders it to argv),
 * and the launch's one settings object — the thinking mode, the fixed CLI
 * preferences, the policy every runtime launches with (hooks; its deny rules
 * unioned with the workspace's permissions into the one `permissions` key) and
 * the workspace's fragment, merged so a key two of them set throws. Unlike tmux there are no hooks of
 * this runtime's own: turns are confirmed by the agent's `turn_started` event
 * and questions held in `canUseTool`.
 */
export function sdkLaunchOptions(input: SdkLaunchInput): AgentLaunchIntent {
  const { launch } = input;
  return {
    cwd: input.cwd,
    guardsRoot: launch.guardsRoot,
    model: input.model ? cliFlagFor(input.model) : null,
    effort: (input.effort && resolveEffortFlag(input.effort)) ?? null,
    settings: mergeLaunchSettings(
      input.effort ? resolveEffortSettings(input.effort) : undefined,
      LAUNCH_CLI_SETTINGS,
      {
        hooks: input.policy.hooks,
        permissions: launchPermissions(input.policy, launch.permissions),
      },
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
    prompt: input.prompt && input.prompt.text.length > 0 ? input.prompt : null,
    appendSystemPrompt: input.appendSystemPrompt || null,
  };
}

/** The policy's deny rules plus the workspace's own allow / deny rules. */
function launchPermissions(
  policy: LaunchPolicy,
  workspace: LaunchPermissions | undefined,
): { allow?: string[]; deny: string[] } {
  return {
    ...(workspace?.allow ? { allow: [...workspace.allow] } : {}),
    deny: [...policy.permissions.deny, ...(workspace?.deny ?? [])],
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
  previous: AgentLaunchIntent,
  rewind: { sessionId: string; anchorUuid: string | null; promptUuid: string },
): AgentLaunchIntent {
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

/**
 * The options of a relaunch that carries on the same session from its end —
 * a new process (so a new account) for an agent whose turn stopped at its
 * account's usage limit.
 */
export function continueRelaunchOptions(
  previous: AgentLaunchIntent,
  sessionId: string,
): AgentLaunchIntent {
  return {
    ...previous,
    fork: false,
    prompt: null,
    sessionId,
    resume: sessionId,
    resumeAt: null,
    resumeDropsTurn: null,
  };
}
