import { z } from "zod";
import { liveValue } from "@plugins/network/plugins/live/core";

/** The machine's sleep clock as of the last publish (packages/sleep-clock's
 *  readSleepClock, minus the platform flag). */
export const SleepNowSchema = z
  .object({
    /** kern.bootsessionuuid — asleepMs compares only within one boot. */
    boot: z.string(),
    /** Cumulative time asleep since boot, machine-wide. */
    asleepMs: z.number(),
    /** Epoch ms of the most recent wake, or null when the OS does not say. */
    wakeAtMs: z.number().nullable(),
  })
  /** null = this platform cannot tell (NOT "it did not sleep"). */
  .nullable();
export type SleepNow = z.infer<typeof SleepNowSchema>;

/**
 * The machine's sleep clock right now, for surfaces that must tell a nap from
 * work on something still running (a live op's last event can be hours old).
 * The browser cannot read the clocks, so the backend publishes the reading —
 * and it changes only when the machine wakes, so it is pushed only then.
 *
 * A schema-bounded scalar. No placeholder: until the first reading lands
 * `useLive` reports it pending. The clock is the computer's, so only the
 * desktop app answers it (`needsMachine`): a reader under an in-browser server
 * gets `unavailable`.
 */
export const machineSleep = liveValue("machine.sleep", {
  schema: SleepNowSchema,
  needsMachine: { feature: "Reading the machine's sleep clock" },
});
