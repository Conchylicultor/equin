import { exists } from "@plugins/packages/plugins/timed-fs/core";
import { REPO_ROOT } from "@plugins/infra/plugins/paths/plugins/repo-root/core";
import { durableCheckoutRoot } from "@plugins/infra/plugins/git/plugins/main-slots/core";
import { join } from "node:path";
import {
  compactionContextHook,
  type CompactionHookEntry,
} from "../../core/hook";

// The hook script in THIS code's checkout (main's newest, for a main slot) —
// the one serving the endpoint it calls. A repo-relative literal, so `./equin plugin move` rewrites it.
const HOOK_SCRIPT_REL =
  "plugins/conversations/plugins/compaction-context/bin/compaction-context.ts";

/**
 * The SessionStart(compact) hook entry an agent launch merges into its
 * settings. Throws when the script is missing: a launch must not install a hook
 * that cannot run.
 */
export async function compactionHookEntry(): Promise<CompactionHookEntry> {
  // Spelled through main's `current` link when this backend runs from a main
  // slot: the agent outlives the slot, which a later build checks out again or
  // reclaims — a slot path baked into its settings then names a deleted script
  // (exit 127 on every hook run, 2026-11-18).
  const checkout = await durableCheckoutRoot(REPO_ROOT);
  const script = join(checkout, HOOK_SCRIPT_REL);
  if (!(await exists(script))) {
    throw new Error(`compaction-context script missing at ${script}`);
  }
  return compactionContextHook({
    checkout,
    script: HOOK_SCRIPT_REL,
  });
}
