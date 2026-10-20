import { z } from "zod";
import { liveValue } from "@plugins/network/plugins/live/core";

/**
 * Who a process on the machine works for. A closed list, in display order:
 * the user's own Chrome, the agents' ops (`./singularity build` / push /
 * check / test / e2e and everything they started), the agent browser's host
 * and its Chromium, and everything else.
 */
export const MACHINE_USAGE_BUCKETS = [
  "chrome",
  "agent-ops",
  "agent-browser",
  "other",
] as const;

export const MachineUsageBucketSchema = z.enum(MACHINE_USAGE_BUCKETS);
export type MachineUsageBucket = z.infer<typeof MachineUsageBucketSchema>;

/** How each bucket is named on screen. */
export const MACHINE_USAGE_BUCKET_LABEL: Record<MachineUsageBucket, string> = {
  chrome: "Your Chrome",
  "agent-ops": "Agent ops",
  "agent-browser": "Agent browser",
  other: "Other",
};

/** What a bucket covers, for a hover. */
export const MACHINE_USAGE_BUCKET_HINT: Record<MachineUsageBucket, string> = {
  chrome: "Google Chrome and its helper processes",
  "agent-ops":
    "Builds, pushes, checks, tests and e2e runs, with every process they started",
  "agent-browser": "The agent browser's host and its headless Chromium",
  other: "Every other process on the machine",
};

export const MachineUsageGroupSchema = z.object({
  bucket: MachineUsageBucketSchema,
  processes: z.number().int().min(0),
  /** Summed `ps` %cpu (100 = one core), the kernel's recent decaying average. */
  cpuPercent: z.number().min(0),
  /**
   * Summed physical footprint (what Activity Monitor shows), bytes; a process
   * whose footprint the kernel would not report counts its resident size.
   */
  memBytes: z.number().int().min(0),
});
export type MachineUsageGroup = z.infer<typeof MachineUsageGroupSchema>;

/**
 * Where the machine's CPU and memory go right now, by who the processes work
 * for. Sampled on subscribe — the health report reads it while its Machine
 * watcher card is expanded — never on a timer.
 */
export const MachineUsageSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("sampled"),
    at: z.string(),
    /** Logical cores: the CPU sum's ceiling is `cores × 100`. */
    cores: z.number().int().min(1),
    totalMemBytes: z.number().int().min(1),
    /** One per bucket, in `MACHINE_USAGE_BUCKETS` order. */
    groups: z.array(MachineUsageGroupSchema),
  }),
]);
export type MachineUsage = z.infer<typeof MachineUsageSchema>;

/** The machine's CPU and memory by bucket, read when subscribed. */
export const machineUsage = liveValue("sentinel.machine-usage", {
  schema: MachineUsageSchema,
});
