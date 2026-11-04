import { z } from "zod";
import { liveValue } from "@plugins/network/plugins/live/core";
import { FindingSchema, IO_HEALTH_RULES } from "./finding";

/** The rules are a closed set and one finding per rule and subject can hold at once; this bounds the list. */
export const ACTIVE_FINDINGS_MAX = 4 * IO_HEALTH_RULES.length;

/** The newest tick, in the few numbers the health row's glance shows. */
export const LatestTickSchema = z.object({
  /** Epoch ms of the tick. */
  at: z.number(),
  maxOpMs: z.number(),
  readOpsS: z.number().nullable(),
  msPerOp: z.number().nullable(),
  load1: z.number(),
});
export type LatestTick = z.infer<typeof LatestTickSchema>;

export const IoHealthSchema = z.discriminatedUnion("monitor", [
  /** The monitor's log does not exist: it was never installed on this machine. */
  z.object({ monitor: z.literal("missing") }),
  z.object({
    monitor: z.literal("present"),
    /** The newest tick in the log. Its age says whether the monitor still runs. */
    latest: LatestTickSchema,
    /** Whether the newest tick carries the root-only attribution fields. */
    root: z.boolean(),
    findings: z.array(FindingSchema).max(ACTIVE_FINDINGS_MAX),
  }),
]);
export type IoHealth = z.infer<typeof IoHealthSchema>;

/**
 * Host file-I/O health as the fs-latency monitor's log last said it: the
 * newest tick and every finding holding over the trailing hour. Pushed on each
 * tick the monitor appends (a file watcher on its log — no timer). Host-global
 * and read from the computer's disk, so `needsMachine`: a host without the
 * computer answers it unavailable.
 */
export const hostIoHealth = liveValue("host.io-health", {
  schema: IoHealthSchema,
  needsMachine: { feature: "Reading the host's disk health monitor" },
});
