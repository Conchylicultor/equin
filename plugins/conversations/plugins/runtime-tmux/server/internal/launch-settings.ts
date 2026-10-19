import type { LaunchHooks } from "@plugins/conversations/plugins/agent-launch/server";
import { mergeLaunchSettings } from "@plugins/conversations/plugins/agent-launch/server";
import type { RelayHookEntry } from "@plugins/conversations/plugins/question-relay/core";
import type { PromptSubmitHookEntry } from "@plugins/conversations/plugins/turn-ledger/server";
import type { LaunchFragment } from "@plugins/conversations/plugins/workspace/server";
import { signalDirForCommands } from "./tmux-hooks";

// The tmux runtime's part of the launch's one `--settings` object (see
// agent-launch's launch-settings.ts for the whole of it): the hooks only a
// pane-hosted session needs, beside the ones every runtime runs with
// (`agentLaunchHooks`).
//
// The hooks are the question's push signal. Nothing on disk says an
// AskUserQuestion menu is up: the CLI buffers the assistant message and writes
// its tool_use only once the tool resolves, and the sessions file reads as an
// ordinary wait (or `busy`, depending on the version). So the agent itself
// touches the conversation's signal file the moment the tool starts
// (`PreToolUse`, before the menu is drawn) and again when it resolves either way
// (`PostToolUse` / `PostToolUseFailure`) or a prompt is submitted
// (`UserPromptSubmit`). The touch only wakes the reconciler; the pane itself
// (pane-menu.ts) still decides whether a menu is on screen.
//
// The question relay (conversations/question-relay) rides the same PreToolUse
// matcher: it HOLDS the call while the web shows the question and answers it
// through `updatedInput`, so the menu is drawn only when the relay lets go.
// Hooks on one matcher run in parallel, so the touch still wakes the reconciler
// at once. A `Notification` touch wakes it when the CLI draws a menu after all
// (a released question) — the one moment nothing else signals.
//
// The turn ledger (conversations/turn-ledger) rides `UserPromptSubmit` beside
// the touch: its entry writes the hook's stdin — the prompt the CLI just
// submitted, verbatim — into the ledger's mailbox, which is how a typed turn is
// confirmed by the CLI itself rather than guessed from the transcript.

const QUESTION_TOOL = "AskUserQuestion";

/**
 * The hooks settings fragment for a pane whose signal file lives in
 * `signalDir`, with the question relay's entry (`relay`, from
 * `relayHookEntry()`) beside the PreToolUse touch and the turn ledger's
 * (`promptSubmit`, from `promptSubmitHookEntry()`) beside the
 * UserPromptSubmit one, merged with the hooks every runtime runs with
 * (`shared`, from `agentLaunchHooks()`) — an event both set throws.
 * `$SINGULARITY_CONVERSATION_ID` is expanded by the shell Claude Code runs the
 * hook in — the pane delivers it (see agent-launch's agent-session-env.ts), so
 * the command is the same string for every conversation.
 */
export function launchHookSettings({
  signalDir,
  relay,
  promptSubmit,
  shared,
}: {
  signalDir: string;
  relay: RelayHookEntry;
  promptSubmit: PromptSubmitHookEntry;
  shared: LaunchHooks;
}): Record<string, unknown> {
  const touch = {
    type: "command",
    command: `touch "${signalDirForCommands(signalDir)}/$SINGULARITY_CONVERSATION_ID"`,
  };
  const onQuestion = [{ matcher: QUESTION_TOOL, hooks: [touch] }];
  return {
    hooks: mergeLaunchSettings(shared, {
      PreToolUse: [{ matcher: QUESTION_TOOL, hooks: [touch, relay] }],
      PostToolUse: onQuestion,
      PostToolUseFailure: onQuestion,
      UserPromptSubmit: [{ hooks: [touch, promptSubmit] }],
      Notification: [{ hooks: [touch] }],
    }),
  };
}

/**
 * `--settings '<json>'`, single-quoted for the pane's shell. JSON never needs a
 * single quote, but a value could carry one; that would end the quoting early,
 * so it throws rather than escaping.
 */
export function settingsFlag(settings: Record<string, unknown>): string {
  const json = JSON.stringify(settings);
  if (json.includes("'")) {
    throw new Error(
      `launch settings contain a single quote and cannot be single-quoted: ${json}`,
    );
  }
  return `--settings '${json}'`;
}

/**
 * The workspace's launch options as CLI arguments, one word each (the caller
 * quotes them for the pane's shell). Its `settings` are not here: they are
 * merged into the one `--settings` object instead.
 *
 * `--mcp-config` is variadic, so `--strict-mcp-config` (a flag) follows it
 * whenever both are set, and a positional argument never directly does — the
 * launch's own flags and `--` come after these.
 */
export function launchFragmentArgv(launch: LaunchFragment): string[] {
  return [
    ...(launch.settingSources
      ? ["--setting-sources", launch.settingSources.join(",")]
      : []),
    ...(launch.mcpServers
      ? ["--mcp-config", JSON.stringify({ mcpServers: launch.mcpServers })]
      : []),
    ...(launch.strictMcpConfig ? ["--strict-mcp-config"] : []),
  ];
}
