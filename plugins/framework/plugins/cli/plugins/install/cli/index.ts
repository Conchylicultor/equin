import { defineCliCommand } from "@plugins/framework/plugins/cli/core";
import { envName } from "@plugins/infra/plugins/launcher/plugins/env-names/core";

/**
 * Install this checkout's dependencies, and do nothing else.
 *
 * The bootstrap (`bin/index.ts`) already runs `ensureDeps()` before every verb,
 * so the install itself happens before this command is even parsed; the body
 * only confirms the stamp and says so. The verb exists so "make this checkout
 * runnable" has a name: `infra/worktree` runs `<checkout>/equin install` right
 * after creating a checkout (a spare, a fresh add, a claimed spare after its
 * switch), so a checkout is installed before its first guard hook or script —
 * never found uninstalled with module resolution escaping into main's tree.
 *
 * Frozen (`--frozen-lockfile`) only when the spawner sets EQUIN_FROZEN_LOCKFILE:
 * the install runs before argv is parsed, so a flag here could not reach it.
 */
export default defineCliCommand<[], object>({
  name: "install",
  description:
    "Install this checkout's node_modules from its own bun.lock (the install every " +
    "./equin command runs first, ~140 ms when already fresh) and exit. With " +
    `${envName("FROZEN_LOCKFILE")}=1 the install` +
    " is `bun install --frozen-lockfile`: a bun.lock " +
    "that disagrees with its package.json files fails instead of being rewritten.",
  run: () => import("./run"),
});
