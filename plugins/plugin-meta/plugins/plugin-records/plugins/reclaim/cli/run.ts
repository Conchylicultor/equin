import type { CliAction } from "@plugins/framework/plugins/cli/core";
import { reclaimRecordStore } from "@plugins/plugin-meta/plugins/plugin-records/cli";

/** One reclaim, one line: the transcript the job tails into its log. */
const run: CliAction<[], object> = () => {
  const t0 = performance.now();
  const r = reclaimRecordStore();
  console.log(
    `${r.keysRead} key rows read, ${r.keysDeleted} deleted, ${r.valuesDeleted} values deleted, ${r.returnsPages ? `${r.pagesFreed} pages freed` : "pages kept (auto_vacuum is not INCREMENTAL)"} in ${((performance.now() - t0) / 1000).toFixed(1)}s`,
  );
  return Promise.resolve();
};

export default run;
