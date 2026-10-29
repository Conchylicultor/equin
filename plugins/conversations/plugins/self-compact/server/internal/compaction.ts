import { and, eq } from "drizzle-orm";
import { db, type DbExecutor } from "@plugins/database/server";
import {
  turnIdKind,
  type TurnId,
  type TurnKind,
} from "@plugins/conversations/plugins/turn-ledger/core";
import type {
  HeldTurn,
  PendingTurnEntry,
  TurnReadiness,
} from "@plugins/conversations/plugins/automatic-turn/server";
import { _conversationCompactions } from "./tables";

/** What sending a compaction reads and does outside its table: ports, so a
 * test drives the policy over the real table with a fake agent. */
export interface CompactionPorts {
  /** Whether an automatic turn may be typed into the conversation now
   * (conversations/automatic-turn), our own pending turn excepted. */
  readiness(conversationId: string, exec: DbExecutor): Promise<TurnReadiness>;
  /** Submit one turn (idempotent on `turnId`). */
  submit(
    conversationId: string,
    turn: { id: TurnId; kind: TurnKind; text: string },
  ): Promise<void>;
}

export type CompactionOutcome =
  | { kind: "none" }
  /** The agent cannot take a turn now; its next status change re-runs this. */
  | HeldTurn
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

/**
 * A pending compaction is a turn of ours waiting for the agent: every other
 * automatic sender (a watch's event delivery) holds until it went out, so
 * `/compact` is typed into an idle CLI and runs as a command. Contributed as
 * `PendingTurn`; `sendCompaction`'s readiness passes it as `own`.
 */
export const compactionTurn: PendingTurnEntry = {
  id: "self-compact",
  pending: (conversationId, exec) => hasPendingCompaction(conversationId, exec),
};

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
 * the compaction is done. Held while the agent cannot take an automatic turn
 * (`ports.readiness`): busy (its own turn is still running), waiting on the
 * user (a turn would answer their question), or another plugin's turn is
 * pending for it.
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
  const readiness = await ports.readiness(conversationId, exec);
  if (readiness.kind === "not-found") return { kind: "none" };
  if (readiness.kind === "held") return readiness;
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
