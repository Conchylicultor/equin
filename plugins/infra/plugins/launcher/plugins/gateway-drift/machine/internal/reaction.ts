import { defineRefReaction } from "@plugins/infra/plugins/git/plugins/git-watcher/server";
import { recheckGatewayDrift } from "./state";

/**
 * Main moved: its gateway source, its launcher (a flag, the bind default) or
 * its runtime-env declaration may now install something else, so re-check —
 * in every backend, since a worktree's backend is not restarted by a push.
 * An in-process reaction: the on-read check is the fallback, so a skipped one
 * costs latency only.
 */
export const gatewayDriftReaction = defineRefReaction({
  name: "launcher.gateway-drift",
  refName: "refs/heads/main",
  run: async () => {
    await recheckGatewayDrift();
  },
});
