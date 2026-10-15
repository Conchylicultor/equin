import type { ChildResourceUsage } from "./types";

/**
 * The ONE reading of a reaped child's `getrusage` into `ChildResourceUsage`.
 *
 * Both spawn shapes call it, so peak RSS and CPU time can never be reported by
 * one and dropped by the other — which is exactly how CPU time came to be
 * missing everywhere: `resourceUsage()` always carried it, and each call site
 * had hand-picked `maxRSS` off the object.
 *
 * `resourceUsage()` is only populated once the child has exited, and returns
 * `null` when the runtime has nothing to report — hence the `undefined` fields
 * rather than zeros, which a caller would print as a real measurement of nothing.
 *
 * `cpuTime` values are BigInt MICROseconds; the `Number` conversion is exact for
 * any run shorter than ~285 years.
 */
export function readResourceUsage(proc: {
  resourceUsage: () =>
    | {
        maxRSS: number;
        cpuTime: { total: number | bigint; system: number | bigint };
      }
    | undefined
    | null;
}): ChildResourceUsage {
  const usage = proc.resourceUsage();
  return {
    maxRssBytes: usage?.maxRSS,
    cpuTimeMicros: usage ? Number(usage.cpuTime.total) : undefined,
    cpuSystemMicros: usage ? Number(usage.cpuTime.system) : undefined,
  };
}
