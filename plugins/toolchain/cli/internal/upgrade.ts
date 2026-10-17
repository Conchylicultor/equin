import type { CliAction } from "@plugins/framework/plugins/cli/core";
import { upgradeThisWorktree } from "@plugins/infra/plugins/deps/plugins/updates/cli";
import { miseUpdater } from "@plugins/infra/plugins/deps/plugins/mise/core";

/**
 * `./singularity toolchain upgrade [--tool a,b]` — the alias of
 * `./singularity deps upgrade mise`: the same updater through the same gated
 * runner. It imports the updater directly rather than going through the
 * updater registry, so it needs no booted backend (the registry is server
 * contributions).
 */
const run: CliAction<[], { tool?: string }> = async (opts) => {
  await upgradeThisWorktree([
    { updater: miseUpdater, only: opts.tool?.split(",").map((t) => t.trim()) },
  ]);
};

export default run;
