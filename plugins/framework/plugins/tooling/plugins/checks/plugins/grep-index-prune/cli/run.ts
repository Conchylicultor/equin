import type { CliAction } from "@plugins/framework/plugins/cli/core";
import { pruneGrepIndex } from "@plugins/framework/plugins/tooling/plugins/checks/cli";

/** One prune, one line: the transcript the job tails into its log. */
const run: CliAction<[], object> = () => {
  const t0 = performance.now();
  const r = pruneGrepIndex();
  console.log(
    `${r.rowsRead} rows read, ${r.rowsDeleted} deleted in ${((performance.now() - t0) / 1000).toFixed(1)}s (${r.transactions} transactions, longest ${Math.round(r.longestHoldMs)} ms)`,
  );
  return Promise.resolve();
};

export default run;
