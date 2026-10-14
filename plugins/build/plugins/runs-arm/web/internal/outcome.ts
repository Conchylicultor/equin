import type { RunRow } from "@plugins/runs/core";
import type { BuildRunOutcome } from "@plugins/build/plugins/build-status/core";
import { buildRunArm } from "../../core";

/**
 * The two fields `BuildStatusDot` / `BuildStatusChip` decide a status from,
 * recovered off a merged row of the build arm.
 *
 * `finishedAt` is a base field every kind has; the exit code is this arm's
 * own. The build-status components are reused exactly as they are on the
 * build pane, and agree with the projected `build.status` by construction
 * (`status-sql.test.ts` holds the SQL equal to `buildStatusOf`).
 */
export function buildOutcomeOf(run: RunRow): BuildRunOutcome {
  return {
    finishedAt: run.finishedAt,
    exitCode: buildRunArm.read(run)?.exitCode ?? null,
  };
}
