import { defineServerContribution } from "@plugins/framework/plugins/server-core/core";

/** What one gate says about a conversation's agent ending its turn. */
export type StopVerdict = { kind: "allow" } | { kind: "block"; reason: string };

/**
 * One plugin's reason an agent may not end its turn yet — work the plugin
 * still requires of it (a report it was asked for). `reason` is what the agent
 * reads as it is sent back to work, so it names the act that clears it.
 */
export interface StopGateEntry {
  /** Stable id, for logs and the docs. */
  id: string;
  check(conversationId: string): Promise<StopVerdict>;
}

/**
 * One plugin's reason an agent may stop even though a gate blocks — it will be
 * woken anyway (a watch whose next event becomes its next turn). Answers the
 * reason, or null when it does not waive.
 */
export interface StopWaiverEntry {
  /** Stable id, for logs and the docs. */
  id: string;
  waives(conversationId: string): Promise<string | null>;
}

export const StopGate = defineServerContribution<StopGateEntry>(
  "conversations.stop-gate",
  { docLabel: (g) => g.id },
);

export const StopWaiver = defineServerContribution<StopWaiverEntry>(
  "conversations.stop-waiver",
  { docLabel: (w) => w.id },
);
