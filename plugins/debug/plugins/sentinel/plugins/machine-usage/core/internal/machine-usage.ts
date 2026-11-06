import { z } from "zod";
import { liveValue } from "@plugins/network/plugins/live/core";
import { cappedList } from "@plugins/packages/plugins/list-bound/core";

/**
 * Who a process on the machine works for. A closed list, in display order:
 * the user's own Chrome, the agents' ops (`./equin build` / push / check /
 * test / e2e and everything they started), the agent browser's host and its
 * Chromium, the agents themselves (each SDK agent and its Claude Code, with
 * the tools it runs outside an op), the app's backends (the gateway, central
 * and every worktree backend), Postgres (the embedded cluster and PgBouncer),
 * and everything else.
 */
export const MACHINE_USAGE_BUCKETS = [
  "chrome",
  "agent-ops",
  "agent-browser",
  "agents",
  "backends",
  "postgres",
  "other",
] as const;

export const MachineUsageBucketSchema = z.enum(MACHINE_USAGE_BUCKETS);
export type MachineUsageBucket = z.infer<typeof MachineUsageBucketSchema>;

/** How each bucket is named on screen. */
export const MACHINE_USAGE_BUCKET_LABEL: Record<MachineUsageBucket, string> = {
  chrome: "Your Chrome",
  "agent-ops": "Agent ops",
  "agent-browser": "Agent browser",
  agents: "Agents",
  backends: "Backends",
  postgres: "Postgres",
  other: "Other",
};

/** What a bucket covers, for a hover. */
export const MACHINE_USAGE_BUCKET_HINT: Record<MachineUsageBucket, string> = {
  chrome: "Google Chrome and its helper processes",
  "agent-ops":
    "Builds, pushes, checks, tests and e2e runs, with every process they started",
  "agent-browser": "The agent browser's host and its headless Chromium",
  agents:
    "Each agent and its Claude Code, with the commands it runs outside an op",
  backends:
    "The gateway, central and every worktree backend, with what they started",
  postgres: "The embedded Postgres cluster and PgBouncer",
  other: "Every other process on the machine",
};

/**
 * Each bucket's colour, wherever a bucket is drawn (the card's bars, the
 * Health pane's owner charts). Theme tokens only: distinct categorical hues,
 * picked (and the green deepened) to read as solid fills; "other" is a dim
 * neutral, so the named buckets stand out against it.
 */
export const MACHINE_USAGE_BUCKET_COLOR: Record<MachineUsageBucket, string> = {
  chrome: "var(--categorical-6)",
  "agent-ops": "var(--categorical-5)",
  "agent-browser": "color-mix(in oklch, var(--categorical-2) 90%, black)",
  agents: "var(--categorical-1)",
  backends: "var(--categorical-3)",
  postgres: "var(--categorical-8)",
  other: "color-mix(in oklch, var(--muted-foreground) 45%, transparent)",
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
    groups: cappedList(MachineUsageGroupSchema, {
      max: MACHINE_USAGE_BUCKETS.length,
    }),
  }),
]);
export type MachineUsage = z.infer<typeof MachineUsageSchema>;

/** The machine's CPU and memory by bucket, read when subscribed. */
export const machineUsage = liveValue("sentinel.machine-usage", {
  schema: MachineUsageSchema,
});

/** Processes named in each persisted sample (the largest by memory, then by CPU). */
export const MACHINE_USAGE_TOP_PROCESSES = 12;

/** One bucket's share of one persisted window. */
export const OwnerUsageSchema = z.object({
  bucket: MachineUsageBucketSchema,
  processes: z.number().int().min(0),
  /**
   * CPU the bucket's processes ran over the window, in cores (1 = one core
   * busy the whole window): the delta of each process's cumulative CPU time
   * plus that of the children it reaped, so a process that lived and died
   * between two readings is charged to its parent's bucket. Missed: what a
   * process the kernel will not report on (another account's) reaped, and
   * what an orphan ran before launchd reaped it. Absent on a sampler's first
   * window (no previous reading to diff).
   */
  cpuCores: z.number().min(0).optional(),
  /** Summed physical footprint at the window's end, MB (see MachineUsageGroup). */
  memMb: z.number().min(0),
});
export type OwnerUsage = z.infer<typeof OwnerUsageSchema>;

/** One process among the largest, named so "other" is never a mystery. */
export const TopProcessSchema = z.object({
  bucket: MachineUsageBucketSchema,
  /** The executable's file name, or the start of a nameless command line. */
  name: z.string(),
  cpuCores: z.number().min(0).optional(),
  memMb: z.number().min(0),
});
export type TopProcess = z.infer<typeof TopProcessSchema>;

/**
 * One persisted reading of where the machine's CPU and memory went, by owner —
 * a line of the main worktree's `health-owners` log, written beside the host
 * sample (`health-host`) on its own cadence so a contention window can be
 * read back as "who" next to "how much".
 */
export const OwnerSampleSchema = z.object({
  sampledAt: z.number(),
  /** The window the CPU deltas cover, ms (absent with them on the first). */
  windowMs: z.number().optional(),
  cores: z.number().int().min(1),
  owners: cappedList(OwnerUsageSchema, { max: MACHINE_USAGE_BUCKETS.length }),
  top: cappedList(TopProcessSchema, { max: MACHINE_USAGE_TOP_PROCESSES }),
});
export type OwnerSample = z.infer<typeof OwnerSampleSchema>;
