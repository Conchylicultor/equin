import { existsSync } from "node:fs";
import { join } from "node:path";
import { stopGateHook, type StopGateHookEntry } from "../../core/hook";

// The hook script beside THIS code — the checkout serving the endpoint it
// calls — resolved from the module, so it needs no git root and follows a move.
const HOOK_SCRIPT = join(import.meta.dir, "../../bin/stop-gate.ts");

/**
 * The Stop hook entry an agent launch merges into its settings. Throws when
 * the script is missing: a launch must not install a hook that cannot run.
 */
export function stopGateHookEntry(): StopGateHookEntry {
  if (!existsSync(HOOK_SCRIPT)) {
    throw new Error(`stop-gate script missing at ${HOOK_SCRIPT}`);
  }
  return stopGateHook({ scriptPath: HOOK_SCRIPT });
}
