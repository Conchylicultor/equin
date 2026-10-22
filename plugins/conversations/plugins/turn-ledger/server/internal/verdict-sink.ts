import { defineReportSink } from "@plugins/primitives/plugins/report-sink/core";

/**
 * A turn that ended in a verdict worth a report: the CLI submitted it merged
 * with other text, or the submit check never saw the input box empty.
 */
export interface TurnVerdict {
  verdict: "merged" | "unverified";
  id: string;
  conversationId: string;
  typedText: string;
  extraText: string | null;
  error: string | null;
}

/**
 * Where the ledger announces a merged or unverified turn. `machine/` maps it to
 * the `turn-merged` / `turn-unverified` reports. A sink, not a direct
 * `recordReport`: the reports engine is not portable, and this barrel runs on
 * every host (the `orphanedAttemptSink` precedent). On a host without the
 * computer nothing registers — no agent ever types a turn there — and the sink
 * holds what was emitted, bounded.
 */
export const turnVerdictSink = defineReportSink<TurnVerdict>();
