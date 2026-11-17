import {
  hookCommand,
  type HookCommand,
} from "@plugins/framework/plugins/tooling/plugins/guards/plugins/agent-policy/core";

// The compaction hook's Claude Code entry, as data: this plugin owns the one
// place its command, matcher and timeout are spelled. The machine half resolves
// the script's absolute path (machine/internal/hook-entry.ts) and the launch
// (agent-launch's `agentLaunchPolicy`) merges the entry into its one settings
// object.

/** The SessionStart source the hook runs on: right after a compaction. */
export const COMPACTION_HOOK_MATCHER = "compact";

/**
 * The hook's timeout, in seconds. Contributions render from the database; this
 * bounds a wedged backend, after which the CLI goes on without the context.
 */
export const COMPACTION_HOOK_TIMEOUT_S = 60;

export interface CompactionHookEntry {
  type: "command";
  command: HookCommand;
  timeout: number;
}

/**
 * The SessionStart hook entry that runs `script` (relative to `checkout`, absolute)
 * through the hook launcher (guards/agent-policy `hookCommand`).
 */
export function compactionContextHook(at: {
  checkout: string;
  script: string;
}): CompactionHookEntry {
  return {
    type: "command",
    command: hookCommand(at),
    timeout: COMPACTION_HOOK_TIMEOUT_S,
  };
}
