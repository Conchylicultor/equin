import { defineServerContribution } from "@plugins/framework/plugins/server-core/core";
import type { DbExecutor } from "@plugins/database/server";

/**
 * One plugin's turn waiting to be typed into a conversation as soon as its
 * agent can take one (a compaction it asked for). While `pending` answers
 * true, every OTHER automatic sender holds: a turn typed first would make the
 * agent busy, and the pending one would then reach a busy CLI — folded into
 * the running turn as plain text at its next tool boundary (a slash command
 * would never run as a command).
 *
 * The contributor clears its own pending state once it sent its turn, and the
 * held senders are re-run by the agent's next status change (that turn ends).
 */
export interface PendingTurnEntry {
  /** Stable id, for logs, the docs and the hold reason. */
  id: string;
  /** Whether this plugin has a turn waiting for `conversationId`. Read on
   * `exec`, so a sender deciding on a transaction sees the same state. */
  pending(conversationId: string, exec: DbExecutor): Promise<boolean>;
}

export const PendingTurn = defineServerContribution<PendingTurnEntry>(
  "conversations.pending-turn",
  { docLabel: (p) => p.id },
);
