import { exists } from "@plugins/packages/plugins/timed-fs/core";
import { REPO_ROOT } from "@plugins/infra/plugins/paths/plugins/repo-root/core";
import { join } from "node:path";
import { stopGateHook, type StopGateHookEntry } from "../../core/hook";

// The hook script in THIS code's checkout — the one serving the endpoint it
// calls. A repo-relative literal, so `./equin plugin move` rewrites it.
const HOOK_SCRIPT_REL =
  "plugins/conversations/plugins/stop-gate/bin/stop-gate.ts";
const HOOK_SCRIPT = join(REPO_ROOT, HOOK_SCRIPT_REL);

/**
 * The Stop hook entry an agent launch merges into its settings. Throws when
 * the script is missing: a launch must not install a hook that cannot run.
 */
export async function stopGateHookEntry(): Promise<StopGateHookEntry> {
  if (!(await exists(HOOK_SCRIPT))) {
    throw new Error(`stop-gate script missing at ${HOOK_SCRIPT}`);
  }
  return stopGateHook({
    checkout: REPO_ROOT,
    script: HOOK_SCRIPT_REL,
  });
}
