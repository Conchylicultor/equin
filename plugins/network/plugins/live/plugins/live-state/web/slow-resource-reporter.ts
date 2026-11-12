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
   * Milliseconds of the settle window the SERVER spent awaiting another run
   * already in flight while answering (the sub-ack's `joinedMs`: a push's
   * flight it joined, a shared memo's pass) — that run's time, judged on its
   * own server span, so not the resource's here. 0 when none or unknown.
   */
  serverJoinedMs: number;
  /**
   * `performance.now()` the transport FIRST became ready (null: not yet). With
   * `transportStartedAtMs` it is the pipeline's whole bring-up wait, which the
   * consumer files once per transport, against the transport, rather than
   * against each resource that waited on it.
   */
  transportReadyAtMs: number | null;
  /**
   * `performance.now()` this tuple's pipeline began bringing its transport up
   * — its first socket opened (null: none yet). A page has several pipelines
   * (its own, and one per scoped transport — a demo's in-browser server), each
   * started when it was first needed, so a bring-up is measured from here,
   * never from the page's start: a scope started 30 s into the page did not
   * wait 30 s on its socket.
   */
  transportStartedAtMs: number | null;
  /**
   * Which transport the tuple's pipeline reads (its worktree socket URL: the
   * page's `/ws/notifications`, a browser server's `browser:<id>:…`) — the key
   * a consumer files each transport's bring-up once by.
   */
  transportId: string;
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
