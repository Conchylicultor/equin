import type {
  Check,
  CheckContext,
  CheckResult,
} from "@plugins/framework/plugins/tooling/core";
import {
  currentRecordStore,
  NO_OUTSIDE_FILES,
} from "@plugins/plugin-meta/plugins/plugin-records/core";
import {
  describeWideKeys,
  keyWidths,
  MAX_UNUSED_KEY_MODULES,
} from "@plugins/plugin-meta/plugins/plugin-records/plugins/key-width/core";
import { EVALUATOR_MODULES } from "../core";

/**
 * Every evaluated record (one per barrel, ~1,900) is keyed by the evaluator's
 * modules over their whole closure, so a module they load re-keys all of them
 * on every change. One barrel import of a single helper from a heavy barrel
 * (barrel-import's load guard taking `dataRootLayout` from `infra/paths`'
 * core) once keyed them on 361 modules, re-keyed by 76 of 484 main commits.
 */
const check: Check = {
  id: "evaluate:evaluator-key-width",
  description: `the barrel evaluator (keyed into every evaluated record) is keyed by at most ${MAX_UNUSED_KEY_MODULES} modules it never calls`,
  async run(ctx: CheckContext): Promise<CheckResult> {
    const repo = await ctx.repo();
    const failure = describeWideKeys(
      await keyWidths(
        {
          snapshot: repo,
          store: currentRecordStore(),
          readOutside: NO_OUTSIDE_FILES,
        },
        EVALUATOR_MODULES,
      ),
    );
    return failure === null ? { ok: true } : { ok: false, message: failure };
  },
};

export default check;
