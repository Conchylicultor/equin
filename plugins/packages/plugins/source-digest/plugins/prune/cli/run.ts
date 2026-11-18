import type { CliAction } from "@plugins/framework/plugins/cli/core";
import { pruneSourceFacts } from "@plugins/packages/plugins/source-digest/cli";

/** One prune, one line: the transcript the job tails into its log. */
const run: CliAction<[], object> = async () => {
  const t0 = performance.now();
  const r = await pruneSourceFacts();
  console.log(
    `${r.rowsRead} rows read, ${r.rowsDeleted} deleted in ${((performance.now() - t0) / 1000).toFixed(1)}s (${r.transactions} transactions, longest ${Math.round(r.longestHoldMs)} ms)`,
  );
};

export default run;
