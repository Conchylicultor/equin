import { defineReportSink } from "@plugins/primitives/plugins/report-sink/core";
import type { LiveStateSocketKind } from "./notifications-client";

/**
 * Subscriptions this tab sent on an OPEN socket that got no answer — no
 * `sub-ack`, `up-to-date` or `sub-error` — within `UNANSWERED_SUB_MS`. The
 * server answers every sub it receives (registration is synchronous on
 * receipt), so an unanswered one means the frame never reached it, or the answer
 * never reached this tab: the transport between them is broken while still
 * reporting "open". Emitted once per stuck sub (the batch is everything that
 * crossed the deadline together); live-state never recovers on its own here —
 * the consumer (infra/health's watchdog) reports it.
 */
export interface UnansweredSubReport {
  socket: LiveStateSocketKind;
  /** How many subs crossed the deadline together. */
  count: number;
  /** The oldest of them: key, params and how long it has waited. */
  oldestKey: string;
  oldestParams: string;
  oldestWaitMs: number;
  /** The transport's view: tabs on the shared socket and this tab's connection id. */
  attachedTabs: number | null;
  connection: string | null;
}

export const unansweredSubReportSink = defineReportSink<UnansweredSubReport>();
