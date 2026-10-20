import {
  MACHINE_USAGE_BUCKET_HINT,
  MACHINE_USAGE_BUCKET_LABEL,
  type MachineUsage,
  type MachineUsageBucket,
} from "../../core";

/** One bucket's line under the bars, and its segment in each. */
export interface BucketView {
  bucket: MachineUsageBucket;
  label: string;
  hint: string;
  /** Share of the whole machine's CPU (every core), 0–1. */
  cpuShare: number;
  /** Share of the machine's memory, 0–1. */
  memShare: number;
  /** `18%` — of the whole machine, so the four add up to the total. */
  cpuText: string;
  /** `7.4 GB` */
  memText: string;
}

export interface MachineUsageView {
  buckets: BucketView[];
  /** `61%` of the whole machine. */
  cpuTotalText: string;
  /** `21 GB` */
  memTotalText: string;
  /** `of 32 GB` */
  memOfText: string;
  /** `7:17 PM` — when the one reading was taken. */
  atText: string;
}

const GB = 1024 ** 3;

function gb(bytes: number): string {
  return `${(bytes / GB).toFixed(bytes < 10 * GB ? 1 : 0)} GB`;
}

function percent(share: number): string {
  return `${Math.round(share * 100)}%`;
}

/** The "Where it goes" block, from one sampled reading. */
export function machineUsageView(usage: MachineUsage): MachineUsageView {
  const cpuCeiling = usage.cores * 100;
  const buckets = usage.groups.map((g) => {
    const cpuShare = Math.min(1, g.cpuPercent / cpuCeiling);
    const memShare = Math.min(1, g.memBytes / usage.totalMemBytes);
    return {
      bucket: g.bucket,
      label: MACHINE_USAGE_BUCKET_LABEL[g.bucket],
      hint: MACHINE_USAGE_BUCKET_HINT[g.bucket],
      cpuShare,
      memShare,
      cpuText: percent(cpuShare),
      memText: gb(g.memBytes),
    };
  });
  const cpu = buckets.reduce((n, b) => n + b.cpuShare, 0);
  const mem = usage.groups.reduce((n, g) => n + g.memBytes, 0);
  return {
    buckets,
    cpuTotalText: percent(Math.min(1, cpu)),
    memTotalText: gb(mem),
    memOfText: `of ${gb(usage.totalMemBytes)}`,
    atText: new Date(usage.at).toLocaleTimeString([], {
      hour: "numeric",
      minute: "2-digit",
    }),
  };
}
