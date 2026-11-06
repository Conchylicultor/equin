import { implementMachine } from "@plugins/infra/plugins/endpoints/machine";
import { Log } from "@plugins/primitives/plugins/log-channels/server";
import {
  liveSupervisedIncarnations,
  stopOnCodeAdopted,
} from "@plugins/infra/plugins/spawn/plugins/daemon/server";
import { closureChangedSince } from "@plugins/packages/plugins/source-digest/server";
import { adoptDeploy } from "../../core";
import { RestartSkip } from "@plugins/build/plugins/restart-skip/plugins/hooks/server";
import { judgeAdoption } from "../../shared/judge";
import { currentProcessView } from "../../shared/process-view";

const log = Log.channel("restart-skip");

/**
 * A deploy asks before restarting this backend. `adopted` only when a fresh
 * process would run exactly this one's code; then every `RestartSkip.Adopted`
 * hook moves its per-process memo to the deploy, as a fresh boot would have
 * read it — so after the answer this process is indistinguishable from the
 * one the restart would have spawned.
 */
export const handleAdopt = implementMachine(adoptDeploy, async ({ body }) => {
  const verdict = await judgeAdoption(
    currentProcessView({
      bootInputs: RestartSkip.BootInput.getContributions(),
      children: liveSupervisedIncarnations(),
      closureSince: closureChangedSince,
    }),
    body,
  );
  if (verdict.kind === "restart") {
    log.publish(`restart needed — ${verdict.reason}`);
    return verdict;
  }
  // A daemon holding only a cache of its own code's work is not judged above
  // (`onCodeAdopted: "stop"`): it is stopped, as a fresh process would not
  // have it yet, and its owner starts it again on the new code.
  await stopOnCodeAdopted();
  for (const hook of RestartSkip.Adopted.getContributions()) {
    await hook.adopt({ commit: body.commit });
  }
  log.publish(`adopted the deploy of ${body.commit} — no restart`);
  return verdict;
});
