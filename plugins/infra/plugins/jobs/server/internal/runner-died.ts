import type { HoldClass } from "../../core";

/** The report kind a dead runner files. Spelled here because THIS is the side
 * that writes the durable line, like `JOB_SLOT_FLOOR_KIND`. */
export const JOB_RUNNER_DIED_KIND = "job-runner-died";

/**
 * The payload behind {@link JOB_RUNNER_DIED_KIND}. A type alias so it is
 * assignable to the fatal reporter's `Record<string, unknown>`; every number the
 * class table owns is carried, so a report keeps saying what was true when filed.
 */
export type JobRunnerDiedReport = {
  /**
   * - `crashed` — the backend exited so the next boot restarts the runner.
   * - `degraded` — the anti-loop latch suppressed that exit: the backend is up
   *   without this runner, and stays so until someone restarts it.
   */
  action: "crashed" | "degraded";
  runnerId: string;
  /** The hold classes this runner's task list serves. */
  serves: HoldClass[];
  concurrency: number;
  /** Whether this runner held the cron schedule, which stops with it. */
  carriesCron: boolean;
  /** What graphile said stopped it. */
  reason: string;
  /** Deliberate exits inside the latch window, including this one. */
  tripsThisWindow: number;
  maxTripsPerWindow: number;
  windowMs: number;
};
