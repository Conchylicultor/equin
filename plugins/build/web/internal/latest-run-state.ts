import { buildStatusOf } from "@plugins/build/plugins/build-status/core";
import type { BuildRun } from "../../core";

/**
 * What the newest build run says right now: still `running` (no `finishedAt`),
 * `failed` (a real bad verdict — a superseded / interrupted / externally-killed
 * run reports no defect, so it is NOT failed), or nothing worth saying.
 *
 * The one reading the Build button and the collapsed bar's ring share, so the
 * two can never disagree about whether a build is running or failed.
 */
export function latestRunState(
  latestRun: BuildRun | undefined,
): "running" | "failed" | null {
  if (latestRun === undefined) return null;
  if (latestRun.finishedAt === null) return "running";
  return buildStatusOf(latestRun) === "failed" ? "failed" : null;
}
