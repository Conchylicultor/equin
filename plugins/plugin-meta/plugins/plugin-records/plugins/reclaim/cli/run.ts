import type { CliAction } from "@plugins/framework/plugins/cli/core";
import { reclaimRecordStore } from "@plugins/plugin-meta/plugins/plugin-records/cli";

/** One reclaim, one line: the transcript the job tails into its log. */
const run: CliAction<[], object> = async () => {
  const t0 = performance.now();
  const r = await reclaimRecordStore();
  console.log(
    `${r.keysRead} key rows read, ${r.keysDeleted} deleted, ${r.valuesDeleted} values deleted, ${r.returnsPages ? `${r.pagesFreed} pages freed` : "pages kept (auto_vacuum is not INCREMENTAL)"} in ${((performance.now() - t0) / 1000).toFixed(1)}s` +
      ` (${r.timing.transactions} transactions, ${(r.timing.waitedMs / 1000).toFixed(1)}s waiting in the writer line, lock held ${(r.timing.heldMs / 1000).toFixed(1)}s, longest ${Math.round(r.timing.longestHoldMs)} ms)`,
  );
};

export default run;
