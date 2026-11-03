import { defineReportSink } from "@plugins/primitives/plugins/report-sink/core";

/**
 * One HTTP stale-drop event emitted by `NotificationsClient.fetchOverHttp` on
 * every drop of a resource GET body (both the same-epoch strict-`<` guard and a
 * cross-boot `stale-epoch` mismatch). live-state stays threshold-agnostic — it
 * only counts consecutive drops and emits; the reports consumer decides what to
 * report on (a sustained `neverApplied` run is the wedge signature, since an
 * applied cache holds newer server truth and heals itself). The sink mirrors the
 * optimistic-divergence pattern: sink in the primitive, collector + report kind
 * in `reports/*`.
 */
export interface HttpStaleDropReport {
  key: string;
  params: Record<string, string>;
  reason: "stale-version" | "stale-epoch";
  /** Consecutive drops since the last successful apply (reset on any apply). */
  consecutiveDrops: number;
  bodyVersion: number;
  haveVersion: number;
  bodyEpoch: string | null;
  entryEpoch: string | null;
  serverEpoch: string | null;
  source: "prime" | "fallback";
  /** Wedge discriminator: no server-vouched value was ever applied for this key. */
  neverApplied: boolean;
}

export const httpStaleDropReportSink = defineReportSink<HttpStaleDropReport>();
