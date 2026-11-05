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

/**
 * A file scan's records are keyed by its `*.scan.ts` module's whole closure
 * (`FileScan.url`), so a scan that imports one helper from a heavy barrel is
 * re-scanned over every file on every edit to that barrel's closure.
 */
const check: Check = {
  id: "plugin-records:scan-key-width",
  description: `every file scan (*.scan.ts) is keyed by at most ${MAX_UNUSED_KEY_MODULES} modules it never calls`,
  async run(ctx: CheckContext): Promise<CheckResult> {
    const repo = await ctx.repo();
    const scans = repo.glob("*.scan.ts").filter((p) => p.endsWith(".scan.ts"));
    const failure = describeWideKeys(
      await keyWidths(
        {
          snapshot: repo,
          store: currentRecordStore(),
          readOutside: () => null,
        },
        scans,
      ),
    );
    return failure === null ? { ok: true } : { ok: false, message: failure };
  },
};

export default check;
