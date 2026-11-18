import type { CliAction } from "@plugins/framework/plugins/cli/core";
import { getMainRepoRoot } from "@plugins/infra/plugins/spawn/core";
import {
  describeHold,
  latestReviewBy,
  utcDay,
} from "@plugins/infra/plugins/deps/plugins/hold/core";
import { declaredDep, liftPinStay, stayPin } from "../../deps";

// A person's decision about a pin lagging main, the other answer to
// `./equin deps pin`: keep the pinned version, with a reason and a review day
// (a hold, bounded like every dependency hold). Compared with main's checkout,
// where the daemons' start scripts run. Nothing is switched or restarted.
const run: CliAction<
  [string],
  { reason?: string; reviewBy?: string; lift?: boolean }
> = async (id, opts) => {
  const dep = await declaredDep(id);
  if (dep.pin === null) {
    throw new Error(
      `${id} declares no pin: it always runs from the checkout's current install, so there is nothing to stay on`,
    );
  }
  if (opts.lift === true) {
    const lifted = await liftPinStay(dep);
    console.log(
      lifted === null
        ? `${id} has no stay to lift.`
        : `Lifted the stay on ${describeHold(lifted)}`,
    );
    return;
  }
  if (opts.reason === undefined || opts.reason.trim() === "") {
    throw new Error(
      `--reason is required: say why ${id} stays on its pinned version`,
    );
  }
  const now = new Date();
  const stay = await stayPin(dep, {
    root: await getMainRepoRoot(),
    now,
    reason: opts.reason,
    reviewBy: opts.reviewBy ?? latestReviewBy(utcDay(now)),
  });
  console.log(
    `${id} stays on its pinned version: ${describeHold(stay)}\n` +
      `Nothing was switched or restarted. Past ${stay.reviewBy} the Dependency upgrades task asks again.`,
  );
};

export default run;
