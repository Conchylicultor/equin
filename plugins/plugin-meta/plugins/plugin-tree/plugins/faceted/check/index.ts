import type {
  Check,
  CheckContext,
  CheckResult,
} from "@plugins/framework/plugins/tooling/core";
import { currentRecordStore } from "@plugins/plugin-meta/plugins/plugin-records/core";
import {
  describeWideKeys,
  keyWidths,
  MAX_UNUSED_KEY_MODULES,
} from "@plugins/plugin-meta/plugins/plugin-records/plugins/key-width/core";
import { facetRecordProducers } from "../core";

/**
 * A facet record is keyed by its facet's module and the extraction harness,
 * each over its whole closure: a facet importing one helper from a heavy
 * barrel re-extracts every plugin on every edit to that barrel's closure, and
 * the harness's key is in every facet record of every plugin.
 */
const check: Check = {
  id: "faceted:facet-key-width",
  description: `every facet module and the facet extraction harness are keyed by at most ${MAX_UNUSED_KEY_MODULES} modules they never call`,
  async run(ctx: CheckContext): Promise<CheckResult> {
    const repo = await ctx.repo();
    const failure = describeWideKeys(
      await keyWidths(
        {
          snapshot: repo,
          store: currentRecordStore(),
          readOutside: () => null,
        },
        await facetRecordProducers(repo),
      ),
    );
    return failure === null ? { ok: true } : { ok: false, message: failure };
  },
};

export default check;
