/**
 * `./equin deploy restart <composition> --server <server>` — restart the
 * installed service and hold the ship's health gate.
 *
 * For a site whose server answers but whose equin is not running (the box
 * link's `down`). It converges nothing and ships nothing: the unit restarts on
 * the release `current` already names, and the gate proves that release is the
 * one answering, settled. Nothing to revert — a release that will not come back
 * is reported with its journal.
 */
import type { CliAction } from "@plugins/framework/plugins/cli/core";
import { restartScript } from "./internal/restart-script";
import { RESTART_MS, resolveTarget, runScript } from "./internal/target";

const run: CliAction<[string], { server: string }> = async (
  composition,
  opts,
) => {
  const target = await resolveTarget({ composition, serverRef: opts.server });
  const { server, install, deployment } = target;

  console.log(
    `Restarting "${composition}" on ${server.name} (${server.host}): ${install.unit}`,
  );
  await runScript(target, {
    script: restartScript({ install, loopbackPort: deployment.loopbackPort }),
    remoteName: `equin-restart-${composition}.sh`,
    timeoutMs: RESTART_MS,
    what: "restart",
  });
  console.log(`\n[done] ${server.name} is serving "${composition}" again.`);
};

export default run;
