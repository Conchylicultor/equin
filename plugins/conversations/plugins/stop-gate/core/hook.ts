import {
  hookCommand,
  type HookCommand,
} from "@plugins/framework/plugins/tooling/plugins/guards/plugins/agent-policy/core";

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

export interface StopGateHookEntry {
  type: "command";
  command: HookCommand;
  timeout: number;
}

/**
 * The Stop hook entry that runs `script` (relative to `checkout`, absolute)
 * through the hook launcher (guards/agent-policy `hookCommand`).
 */
export function stopGateHook(at: {
  checkout: string;
  script: string;
}): StopGateHookEntry {
  return {
    type: "command",
    command: hookCommand(at),
    timeout: STOP_GATE_HOOK_TIMEOUT_S,
  };
}
