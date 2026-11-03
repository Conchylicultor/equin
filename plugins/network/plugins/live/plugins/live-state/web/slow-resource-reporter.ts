import { defineReportSink } from "@plugins/primitives/plugins/report-sink/core";

export interface SlowResourceInfo {
  key: string;
  params: unknown;
  durationMs: number;
  /**
   * Root-cause attribution, NOT a suppression signal. True when the
   * notifications transport was not yet ready at the moment this resource
   * mounted — so its mount→first-data settle is dominated by transport bring-up
   * (cold-start), not the resource's own compute cost. The signal still fires
   * with its full duration; this only says WHY it was slow.
   */
  transportColdStart: boolean;
  /**
   * Milliseconds of the settle window spent waiting for the transport to FIRST
   * become ready (0 if the transport was already ready when the resource
   * mounted). This is the portion of `durationMs` chargeable to transport
   * bring-up rather than the resource.
   */
  transportWaitMs: number;
  /**
   * `performance.now()` the transport FIRST became ready (null: not yet) — the
   * page's whole bring-up wait, which the consumer files once, against the
   * transport, rather than against each resource that waited on it.
   */
  transportReadyAtMs: number | null;
}

/**
 * One resource tuple's mount→first-data settle duration, emitted by
 * `useResource` / `useResources` on every settle. A domain plugin (`debug/slow-ops`) registers the handler at
 * mount time; live-state stays threshold-agnostic and never decides what "slow"
 * means — the consumer gates on its own threshold (pre-hydrated resources settle
 * at ~0ms and are correctly ignored downstream).
 *
 * This is an EMIT slot, not an installed sink: nothing here reads a value back
 * or asks whether anything is registered, and an unregistered sink is the
 * ordinary steady state (nobody has mounted the collector). So it is the
 * write-side twin — `defineReportSink`, exactly as `httpStaleDropReportSink`
 * next door — rather than `defineInstallSink`, and it inherits that primitive's
 * never-throw contract on the emit path.
 */
export const slowResourceReportSink = defineReportSink<SlowResourceInfo>();
