import type { CliAction } from "@plugins/framework/plugins/cli/core";
import { cliExecContext } from "@plugins/infra/plugins/jobs/plugins/supervised-job/cli";
import { declaredDep, pinDep } from "../../deps";

// The explicit switch of a pinned dependency (a host daemon's binaries): pin
// this checkout's install. Nothing is restarted — the declaration's
// `appliesAt` says when the daemon picks it up.
const run: CliAction<[string], object> = async (id) => {
  const dep = await declaredDep(id);
  if (dep.pin === null) {
    throw new Error(
      `${id} declares no pin: it always runs from the checkout's current install, so there is nothing to switch`,
    );
  }
  const { from, to } = await pinDep(dep, cliExecContext(), {
    log: (line) => console.log(line),
  });
  if (from?.identity === to.identity) {
    console.log(`${id} is already pinned to ${to.identity} (${to.dir})`);
    return;
  }
  console.log(
    `${id} pinned to ${to.identity} (${to.dir})${from === null ? "" : `, was ${from.identity}`}.\n` +
      `It takes effect at ${dep.pin.appliesAt}; nothing was restarted.`,
  );
};

export default run;
