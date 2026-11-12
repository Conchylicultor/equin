import { defineServerContribution } from "@plugins/framework/plugins/server-core/core";
import type { IdleBlockerReading } from "../../core";

/**
 * One thing that keeps the host from being idle — agents working, an op
 * running, the box under duress. The idle core reads every contribution and
 * names none of them.
 *
 * A blocker calls `requestIdleEvaluation()` whenever its input changes (a
 * watch, a trigger): the evaluation then reads it. What it cannot be told
 * about (a lease lapsing on the clock) it answers as `recheckAt`.
 */
export interface IdleBlockerEntry {
  /** Stable id, shown beside its label and used in logs. */
  id: string;
  read(): Promise<IdleBlockerReading>;
}

export const IdleBlocker = defineServerContribution<IdleBlockerEntry>(
  "host.idle-blocker",
  { docLabel: (b) => b.id },
);
