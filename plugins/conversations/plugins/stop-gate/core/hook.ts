// The stop-gate hook's Claude Code entry, as data: this plugin owns the one
// place its command and timeout are spelled. The machine half resolves the
// script's absolute path (machine/internal/hook-entry.ts) and the launch
// (agent-launch's `agentLaunchPolicy`) merges the entry into its one settings
// object, under `Stop`.

/**
 * The hook's timeout, in seconds — above the script's own give-up on an
 * unreachable backend (shared/client.ts), so the script always answers first
 * (failing open) rather than the CLI killing it.
 */
export const STOP_GATE_HOOK_TIMEOUT_S = 30;

// The command is run by the CLI's own hook shell, so the path is held to a
// plain-path alphabet rather than escaped for it.
const SAFE_PATH_RE = /^\/[A-Za-z0-9_./ +-]+$/;

export interface StopGateHookEntry {
  type: "command";
  command: string;
  timeout: number;
}

/** The Stop hook entry that runs the script at `scriptPath` (absolute). */
export function stopGateHook({
  scriptPath,
}: {
  scriptPath: string;
}): StopGateHookEntry {
  if (!SAFE_PATH_RE.test(scriptPath)) {
    throw new Error(
      `stop-gate script path ${JSON.stringify(scriptPath)} must be ` +
        `absolute and plain (it is spliced into a hook command)`,
    );
  }
  return {
    type: "command",
    command: `bun "${scriptPath}"`,
    timeout: STOP_GATE_HOOK_TIMEOUT_S,
  };
}
