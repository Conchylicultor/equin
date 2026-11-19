import { buildStatusOf } from "@plugins/build/plugins/build-status/core";
import type { HealthStatus } from "@plugins/shell/plugins/health-report/core";
import type { BuildRun } from "../../core";

/**
 * The health report's "Update not deployed" row, decided from this
 * namespace's build history (newest `startedAt` first, as `buildHistory`
 * serves it).
 *
 * It speaks only when the newest CLOSED run ended `out-of-memory`: the
 * computer ran out of memory while checking an update, so nothing deployed
 * and no code is to blame — the one no-verdict end the user can act on (free
 * memory), and on an 8 GB Linux host the way main's automatic deploy ends.
 * Any other history is `absent`: a failed build has its own red tray, and a
 * superseded / killed / interrupted one is not the user's news.
 *
 * A run in flight above it is the retry: the row stays, pulsing, until that
 * run closes and decides it. The commit still running is the newest
 * successful run below it that built one of its targets — absent from the
 * window (50 runs), the summary leaves it out rather than guess.
 */
export function outOfMemoryHealth(runs: readonly BuildRun[]): HealthStatus {
  const closedAt = runs.findIndex((r) => r.finishedAt !== null);
  const closed = runs[closedAt];
  if (closed === undefined || buildStatusOf(closed) !== "out-of-memory")
    return { state: "absent" };
  const retrying = runs.slice(0, closedAt).some((r) => r.finishedAt === null);
  const served = runs
    .slice(closedAt + 1)
    .find(
      (r) =>
        buildStatusOf(r) === "success" &&
        r.commitHash !== null &&
        r.targets.some((t) => closed.targets.includes(t)),
    );
  const still =
    served?.commitHash != null
      ? ` equin is still running ${served.commitHash.slice(0, 9)}, the version from before.`
      : " equin is still running the version from before.";
  const next = retrying
    ? " A build is running now."
    : " Closing other apps frees memory for the next attempt: equin retries a few times, then waits for the next update or for Build.";
  return {
    state: "attention",
    title: "Update not deployed",
    summary: `Your computer ran out of memory while checking the update${closed.commitHash !== null ? ` (${closed.commitHash.slice(0, 9)})` : ""}.${still}${next}`,
    transitioning: retrying,
  };
}
