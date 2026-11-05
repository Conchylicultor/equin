import { implement } from "@plugins/infra/plugins/endpoints/core";
import { closureChangedSince } from "@plugins/packages/plugins/source-digest/central";
import { adoptCentralDeploy } from "../../core";
import { judgeAdoption } from "../../shared/judge";
import { currentProcessView } from "../../shared/process-view";

/**
 * Main's deploy asks before restarting central. Central holds no per-deploy
 * memo (no commit pin, no web graph), so `adopted` is the judgement alone.
 */
export const handleCentralAdopt = implement(
  adoptCentralDeploy,
  async ({ body }) => {
    const verdict = await judgeAdoption(
      // Central runs no supervised daemon (infra/spawn/daemon is a backend
      // primitive), so it has no child to vouch for.
      currentProcessView({
        bootInputs: [],
        children: [],
        closureSince: closureChangedSince,
      }),
      body,
    );
    console.log(
      verdict.kind === "adopted"
        ? "[restart-skip] central adopted the deploy — no restart"
        : `[restart-skip] central restart needed — ${verdict.reason}`,
    );
    return verdict;
  },
);
