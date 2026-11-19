import type { LatencyClientKind, LatencyMetric } from "./metrics";

/**
 * The ledger per UTC day (server `loadDailyLatency`): p50 / p95 per (day,
 * metric, client kind) over every minute the machine was awake, and the
 * machine's minutes per day by class.
 */
export interface DailyLatency {
  metrics: {
    /** `YYYY-MM-DD`, UTC. */
    day: string;
    metric: LatencyMetric;
    clientKind: LatencyClientKind;
    /** The day's histogram (HISTOGRAM_SCHEME), so days merge into any period. */
    counts: number[];
    count: number;
    p50Ms: number | null;
    p95Ms: number | null;
    maxMs: number | null;
    censored: number;
    /** Hidden-tab samples and every sample of a slept minute. */
    excluded: number;
  }[];
  hosts: {
    day: string;
    calmMinutes: number;
    pressureMinutes: number;
    sleptMinutes: number;
    /** Minutes with no host record: the server was down or not writing. */
    unknownMinutes: number;
  }[];
}
