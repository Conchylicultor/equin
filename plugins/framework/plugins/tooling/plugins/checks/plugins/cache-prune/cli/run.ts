import type { CliAction } from "@plugins/framework/plugins/cli/core";
import { pruneCheckCache } from "@plugins/framework/plugins/tooling/plugins/checks/core";

/** One sweep, one line: the transcript the job tails into its log. */
const run: CliAction<[], object> = () => {
  const t0 = performance.now();
  const r = pruneCheckCache();
  console.log(
    `${r.entries} entries, ${r.flightFiles} flight files; ${r.removed} entries removed in ${((performance.now() - t0) / 1000).toFixed(2)}s`,
  );
  return Promise.resolve();
};

export default run;
