// The compaction hook's Claude Code entry, as data: this plugin owns the one
// place its command, matcher and timeout are spelled. The server resolves the
// script's absolute path (server/internal/hook-entry.ts) and the launch
// (runtime-tmux) merges the entry into its one `--settings` object.

/** The SessionStart source the hook runs on: right after a compaction. */
export const COMPACTION_HOOK_MATCHER = "compact";

/**
 * The hook's timeout, in seconds. Contributions render from the database; this
 * bounds a wedged backend, after which the CLI goes on without the context.
 */
export const COMPACTION_HOOK_TIMEOUT_S = 60;

// The command crosses two shells (the pane's single-quoted `--settings`, then
// the CLI's own hook shell), so the path is held to a plain-path alphabet
// rather than escaped for both.
const SAFE_PATH_RE = /^\/[A-Za-z0-9_./ +-]+$/;

export interface CompactionHookEntry {
  type: "command";
  command: string;
  timeout: number;
}

/** The SessionStart hook entry that runs the script at `scriptPath` (absolute). */
export function compactionContextHook({
  scriptPath,
}: {
  scriptPath: string;
}): CompactionHookEntry {
  if (!SAFE_PATH_RE.test(scriptPath)) {
    throw new Error(
      `compaction-context script path ${JSON.stringify(scriptPath)} must be ` +
        `absolute and plain (it is spliced into a hook command)`,
    );
  }
  return {
    type: "command",
    command: `bun "${scriptPath}"`,
    timeout: COMPACTION_HOOK_TIMEOUT_S,
  };
}
