import {
  COMPACTION_HOOK_MATCHER,
  type CompactionHookEntry,
} from "@plugins/conversations/plugins/compaction-context/core";
import { compactionHookEntry } from "@plugins/conversations/plugins/compaction-context/server";

// The one settings object a launch hands Claude Code — the SDK's `settings`
// option. Several
// contributors share it: the thinking mode (`{"ultracode":true}`, from
// effort-provider), the fixed CLI preferences (`LAUNCH_CLI_SETTINGS`), the
// hooks (the ones every runtime needs, `agentLaunchHooks`, plus the runtime's
// own) and the workspace's fragment. One object, merged by
// `mergeLaunchSettings` — two objects would leave which one wins to the CLI.

/**
 * CLI preferences every app-launched agent runs with.
 *
 * `promptSuggestionEnabled: false` — after each turn the CLI runs a side query
 * predicting the user's next message. That query can call tools, and when it
 * calls AskUserQuestion the question relay cannot tell it from the agent's own
 * call, so the web shows a held "Should I stay silent?" card the agent never
 * asked. Users drive these agents from the web, not the pane's prompt, so the
 * ghost text the query feeds is never seen anyway.
 */
export const LAUNCH_CLI_SETTINGS: Record<string, unknown> = {
  promptSuggestionEnabled: false,
};

/** A `hooks` settings map: hook event → its matcher groups. */
export type LaunchHooks = Record<string, unknown[]>;

/**
 * The Claude Code hooks every app-launched agent runs with, whatever runtime
 * hosts it — the runtime adds its own beside them, in the same `hooks` map.
 *
 * The compaction hook (conversations/compaction-context) rides `SessionStart`
 * on the `compact` source: right after the CLI compacts the agent's context, it
 * hands back what plugins had given the agent through tool results and the
 * summary dropped (a page's instructions), as `additionalContext`.
 */
export function agentLaunchHooks(
  entries: { compaction: CompactionHookEntry } = {
    compaction: compactionHookEntry(),
  },
): LaunchHooks {
  return {
    SessionStart: [
      { matcher: COMPACTION_HOOK_MATCHER, hooks: [entries.compaction] },
    ],
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
