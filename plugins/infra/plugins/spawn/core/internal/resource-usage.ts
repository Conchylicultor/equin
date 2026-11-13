import type { AppPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import {
  peakFootprintReportEnv,
  readPeakFootprintReport,
  type PeakFootprint,
} from "@plugins/packages/plugins/proc-rusage/core";
import { join } from "node:path";
import type { ChildResourceUsage } from "./types";

/**
 * How a spawn learns its child's peak physical footprint: the variables to add
 * to the child's environment, and the read once it has exited. Without
 * `peakFootprint: "report"` there is nothing to add, and the answer is
 * `not-requested` — never getrusage's `maxRSS`, which counts pages the child had
 * already freed (`packages/proc-rusage`, `PeakFootprint`).
 */
export function peakFootprintRequest(
  dir: AppPath,
  asked: "report" | undefined,
  env: Record<string, string | undefined> | undefined,
): {
  env: Record<string, string>;
  read: () => Promise<PeakFootprint>;
} {
  if (asked === undefined) {
    return {
      env: {},
      read: async () => ({ kind: "unmeasured", why: "not-requested" }),
    };
  }
  const reportPath = join(dir, "peak-footprint.json");
  return {
    env: peakFootprintReportEnv(reportPath, env ?? process.env),
    read: () => readPeakFootprintReport(reportPath),
  };
}

/**
 * The ONE reading of a reaped child's usage into `ChildResourceUsage`.
 *
 * Both spawn shapes call it, so a field can never be reported by one and
 * dropped by the other — which is exactly how CPU time came to be missing
 * everywhere: `resourceUsage()` always carried it, and each call site had
 * hand-picked the peak RSS off the object.
 *
 * CPU comes from `getrusage` (`resourceUsage()`, populated once the child has
 * exited; `null` when the runtime has nothing to report — hence `undefined`
 * rather than zeros). Its `maxRSS` is deliberately NOT read: the peak memory is
 * the child's own report of its physical footprint (`peakFootprintRequest`).
 *
 * `cpuTime` values are BigInt MICROseconds; the `Number` conversion is exact for
 * any run shorter than ~285 years.
 */
export async function readResourceUsage(
  proc: {
    resourceUsage: () =>
      | { cpuTime: { total: number | bigint; system: number | bigint } }
      | undefined
      | null;
  },
  peak: { read: () => Promise<PeakFootprint> },
): Promise<ChildResourceUsage> {
  const usage = proc.resourceUsage();
  return {
    peakFootprint: await peak.read(),
    cpuTimeMicros: usage ? Number(usage.cpuTime.total) : undefined,
    cpuSystemMicros: usage ? Number(usage.cpuTime.system) : undefined,
  };
}
