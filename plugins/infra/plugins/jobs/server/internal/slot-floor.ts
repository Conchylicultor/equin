import type { HoldClass } from "../../core/hold";

/** The report kind a floor trip files. Spelled here because THIS is the side
 * that writes the durable line (synchronously, on the way out); the
 * `deadline-audit` sub-plugin imports this constant to register the kind, so
 * there is one spelling rather than two. */
export const JOB_SLOT_FLOOR_KIND = "job-slot-floor";

/**
 * The payload behind {@link JOB_SLOT_FLOOR_KIND}, in both arms.
 *
 * A type alias rather than an interface so it is assignable to the fatal
 * reporter's `Record<string, unknown>` — and every number a renderer might want
 * to print is CARRIED here, including the ones the class table owns (`serves`,
 * `concurrency`, `minUsableSlots`). A renderer that re-derived them would print
 * today's table against a report filed under yesterday's.
 */
export type JobSlotFloorReport = {
  /**
   * - `crashed` — the longest-class runner fell below the floor and this
   *   process exited deliberately.
   * - `degraded` — the pool lost capacity but the process stayed up: either a
   *   NARROWER runner went fully forfeited (its work still reaches the wider
   *   runners, so the pool is degraded rather than dead), or the floor tripped
   *   and the anti-loop latch suppressed the exit — which `restartSuppressed`
   *   discriminates.
   */
  action: "crashed" | "degraded";
  /** True only on the suppressed floor trip: the condition was fatal, and we
   * chose not to act on it because exiting again would not fix it. */
  restartSuppressed: boolean;
  runnerId: string;
  /** The hold classes this runner's task list serves. */
  serves: HoldClass[];
  /** Slots still worth something on that runner, and its declared total. */
  usable: number;
  concurrency: number;
  /** The floor this was measured against — carried so the renderer never
   * restates it. */
  minUsableSlots: number;
  /** Which runs are sitting in the written-off slots, on this runner. */
  holders: {
    jobId: string;
    jobName: string;
    hold: HoldClass;
    heldMs: number;
  }[];
  /**
   * How many times this worktree has tripped the floor inside the latch
   * window, INCLUDING this trip — trips, not exits, because the suppressed one
   * counts too. `0` on the `degraded` arm of a narrower runner, which is not a
   * floor trip at all.
   */
  tripsThisWindow: number;
  /** The latch's own numbers, carried so the renderer never restates them:
   * after this many trips inside this window, the exit is suppressed. */
  maxTripsPerWindow: number;
  windowMs: number;
};
