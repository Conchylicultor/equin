import {
  COMPACTION_HOOK_MATCHER,
  type CompactionHookEntry,
} from "@plugins/conversations/plugins/compaction-context/core";
import type { RelayHookEntry } from "@plugins/conversations/plugins/question-relay/core";
import type { PromptSubmitHookEntry } from "@plugins/conversations/plugins/turn-ledger/server";
import { signalDirForCommands } from "./tmux-hooks";

// The one `--settings` object a launch hands Claude Code. Three contributors
// share it: the thinking mode (`{"ultracode":true}`, from effort-provider), the
// fixed CLI preferences (`LAUNCH_CLI_SETTINGS`) and the hooks below. One object, one flag — two `--settings` flags would leave which
// one wins to the CLI.
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
//
// The compaction hook (conversations/compaction-context) rides `SessionStart`
// on the `compact` source: right after the CLI compacts the agent's context, it
// hands back what plugins had given the agent through tool results and the
// summary dropped (a page's instructions), as `additionalContext`.

const QUESTION_TOOL = "AskUserQuestion";

/**
 * CLI preferences every app-launched agent runs with.
 *
 * `promptSuggestionEnabled: false` — after each turn the CLI runs a side query
 * predicting the user's next message. That query can call tools, and when it
 * calls AskUserQuestion the PreToolUse relay below cannot tell it from the
 * agent's own call, so the web shows a held "Should I stay silent?" card the
 * agent never asked. Users drive these agents from the web, not the pane's
 * prompt, so the ghost text the query feeds is never seen anyway.
 */
export const LAUNCH_CLI_SETTINGS: Record<string, unknown> = {
  promptSuggestionEnabled: false,
};

/**
 * The hooks settings fragment for a pane whose signal file lives in
 * `signalDir`, with the question relay's entry (`relay`, from
 * `relayHookEntry()`) beside the PreToolUse touch and the turn ledger's
 * (`promptSubmit`, from `promptSubmitHookEntry()`) beside the
 * UserPromptSubmit one, and the compaction hook's (`compaction`, from
 * `compactionHookEntry()`) on SessionStart's `compact` source.
 * `$SINGULARITY_CONVERSATION_ID` is expanded by the shell Claude Code runs the
 * hook in — the pane delivers it (see agent-session-env.ts), so the command is
 * the same string for every conversation.
 */
export function launchHookSettings({
  signalDir,
  relay,
  promptSubmit,
  compaction,
}: {
  signalDir: string;
  relay: RelayHookEntry;
  promptSubmit: PromptSubmitHookEntry;
  compaction: CompactionHookEntry;
}): Record<string, unknown> {
  const touch = {
    type: "command",
    command: `touch "${signalDirForCommands(signalDir)}/$SINGULARITY_CONVERSATION_ID"`,
  };
  const onQuestion = [{ matcher: QUESTION_TOOL, hooks: [touch] }];
  return {
    hooks: {
      PreToolUse: [{ matcher: QUESTION_TOOL, hooks: [touch, relay] }],
      PostToolUse: onQuestion,
      PostToolUseFailure: onQuestion,
      UserPromptSubmit: [{ hooks: [touch, promptSubmit] }],
      Notification: [{ hooks: [touch] }],
      SessionStart: [{ matcher: COMPACTION_HOOK_MATCHER, hooks: [compaction] }],
    },
  };
}

/**
 * Merge the launch's settings fragments into one object. A key two fragments
 * both set throws: neither may silently overwrite the other.
 */
export function mergeLaunchSettings(
  ...fragments: Array<Record<string, unknown> | undefined>
): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  for (const fragment of fragments) {
    if (!fragment) continue;
    for (const [key, value] of Object.entries(fragment)) {
      if (key in merged) {
        throw new Error(
          `launch settings: two fragments both set "${key}" — merge them explicitly`,
        );
      }
      merged[key] = value;
    }
  }
  return merged;
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
