import { useLive } from "@plugins/network/plugins/live/web";
import { foldResource } from "@plugins/primitives/plugins/live-state/web";
import { machineSleep, type SleepNow } from "../../core";

/**
 * The machine's sleep clock as the backend last published it — loading until
 * the first reading lands; a ready `null` means the platform cannot tell;
 * `unavailable` under a host without the computer (the clock is its own).
 */
export function useSleepNow() {
  return useLive(machineSleep);
}

/**
 * The reading as op-log's fold parameter `sleepNow`, whose `null` already
 * means "unknown": the fold then derives no live tail sleep and counts the
 * stretch since an op's last event as it always did — exactly what a reader
 * without the reading knows. So while the value loads, if its read fails, or
 * where there is no computer to read it from (`unavailable`),
 * this hands the fold that unknown rather than blocking the surface on a
 * clock that refines one number. Never use it to render the reading itself —
 * that is `useSleepNow`'s result, with every state.
 */
export function useSleepNowForFold(): SleepNow {
  return foldResource(useSleepNow(), {
    loading: () => null,
    error: () => null,
    unavailable: () => null,
    ready: (now) => now,
  });
}
