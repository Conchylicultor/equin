import { and, eq } from "drizzle-orm";
import { db, type DbExecutor } from "@plugins/database/server";
import {
  turnIdKind,
  type TurnId,
  type TurnKind,
} from "@plugins/conversations/plugins/turn-ledger/core";
import { _conversationCompactions } from "./tables";

/** What sending a compaction reads and does outside its table: ports, so a
 * test drives the policy over the real table with a fake agent. */
export interface CompactionPorts {
  /** The conversation's state; null when it does not exist. */
  conversation(
    id: string,
  ): Promise<{ busy: boolean; waitingFor: string | null } | null>;
  /** Submit one turn (idempotent on `turnId`). */
  submit(
    conversationId: string,
    turn: { id: TurnId; kind: TurnKind; text: string },
  ): Promise<void>;
}

export type CompactionOutcome =
  | { kind: "none" }
  /** The agent cannot take a turn now; its next status change re-runs this. */
  | { kind: "held"; reason: "busy" | "waiting-for" }
  | { kind: "sent" };

/** The turn the agent continues with, after the compaction. */
export function continuationText(next: string): string {
  return `Your context was compacted, as you asked. Continue with: ${next}`;
}

/**
 * Record that `conversationId` asked to be compacted. Sent once its turn ends
 * (`sendCompaction`); a request made again before then replaces this one.
 */
export async function requestCompaction(
  conversationId: string,
  request: { keep: string; next: string },
  exec: DbExecutor = db,
): Promise<void> {
  const row = {
    conversationId,
    ...request,
    compactTurnId: turnIdKind.mint(),
    nextTurnId: turnIdKind.mint(),
    requestedAt: new Date(),
  };
  await exec.insert(_conversationCompactions).values(row).onConflictDoUpdate({
    target: _conversationCompactions.conversationId,
    set: row,
  });
}

/** Whether `conversationId` has a compaction waiting to be sent. */
export async function hasPendingCompaction(
  conversationId: string,
  exec: DbExecutor = db,
): Promise<boolean> {
  const [row] = await exec
    .select({ id: _conversationCompactions.conversationId })
    .from(_conversationCompactions)
    .where(eq(_conversationCompactions.conversationId, conversationId))
    .limit(1);
  return row !== undefined;
}

/**
 * Send `conversationId`'s pending compaction, if it can take a turn: the
 * `/compact` turn, then the continuation, which the agent's CLI queues until
 * the compaction is done. Held while the agent is busy (its own turn is still
 * running) or waiting on the user (a turn would answer their question).
 */
export async function sendCompaction(
  conversationId: string,
  ports: CompactionPorts,
  exec: DbExecutor = db,
): Promise<CompactionOutcome> {
  const [row] = await exec
    .select()
    .from(_conversationCompactions)
    .where(eq(_conversationCompactions.conversationId, conversationId))
    .limit(1);
  if (row === undefined) return { kind: "none" };
  const state = await ports.conversation(conversationId);
  if (state === null) return { kind: "none" };
  if (state.busy) return { kind: "held", reason: "busy" };
  if (state.waitingFor !== null) return { kind: "held", reason: "waiting-for" };
  await ports.submit(conversationId, {
    id: turnIdKind.parse(row.compactTurnId),
    kind: "compact",
    text: `/compact ${row.keep}`,
  });
  await ports.submit(conversationId, {
    id: turnIdKind.parse(row.nextTurnId),
    kind: "event",
    text: continuationText(row.next),
  });
  // Only this request: one made while these turns went out is the next one.
  await exec
    .delete(_conversationCompactions)
    .where(
      and(
        eq(_conversationCompactions.conversationId, conversationId),
        eq(_conversationCompactions.compactTurnId, row.compactTurnId),
      ),
    );
  return { kind: "sent" };
}
