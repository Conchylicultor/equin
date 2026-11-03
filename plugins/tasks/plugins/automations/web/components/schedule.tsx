import type { ReactElement } from "react";
import {
  NextRun,
  useBackgroundEntry,
} from "@plugins/infra/plugins/background/plugins/catalog/web";
import type { BackgroundEntry } from "@plugins/infra/plugins/background/plugins/catalog/core";
import type { ResourceResult } from "@plugins/network/plugins/live/plugins/live-state/web";
import type { AutomationTrigger } from "../../core";

/**
 * The automation's job as Background activity lists it — the one place its
 * schedule is put in words, its next firing is known, and Run now is offered.
 * `null` once the catalog is known and has no such job.
 */
export function useAutomationJob(
  trigger: AutomationTrigger,
): ResourceResult<BackgroundEntry | null> {
  return useBackgroundEntry("job", trigger.jobName);
}

/**
 * When it next runs: a countdown where this backend schedules it, "runs on
 * main" where the job is main-only and this is a worktree, nothing while
 * unknown. `prefix` (a separator) is drawn only when there is something to say.
 */
export function NextRunWords({
  job,
  prefix = "",
}: {
  job: ResourceResult<BackgroundEntry | null>;
  prefix?: string;
}): ReactElement | null {
  if (job.status !== "ready" || job.data === null) return null;
  const entry = job.data;
  if (!entry.runsHere) return <>{prefix}runs on main</>;
  if (entry.trigger.kind !== "cron" || entry.trigger.nextAt === null) {
    return null;
  }
  return (
    <>
      {prefix}
      <NextRun at={new Date(entry.trigger.nextAt)} />
    </>
  );
}
