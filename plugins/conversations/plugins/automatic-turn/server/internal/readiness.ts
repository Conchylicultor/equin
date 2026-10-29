import { eq } from "drizzle-orm";
import { db, type DbExecutor } from "@plugins/database/server";
import { _conversations } from "@plugins/tasks/plugins/tasks-core/server";
import { isAgentBusy } from "@plugins/conversations/core";
import { PendingTurn, type PendingTurnEntry } from "./registry";

/**
 * Whether an automatic turn may be typed into a conversation now. `held` is
 * re-decided by the conversation's next `conversation.statusChanged` (its
 * status, or what it waits on, moved) — a sender that holds re-runs there.
 */
export type TurnReadiness =
  | { kind: "ready" }
  | { kind: "not-found" }
  /** Busy: its turn (or background work) is running — a turn typed now would
   * be folded into it. Waiting-for: it waits on the user (a question) — a turn
   * would answer it. */
  | { kind: "held"; reason: "busy" | "waiting-for" }
  /** Another plugin's turn goes first (`by`: its PendingTurn id). */
  | { kind: "held"; reason: "pending-turn"; by: string };

/** A held readiness: what a sender reports when it holds its turn. */
export type HeldTurn = Extract<TurnReadiness, { kind: "held" }>;

/** The readiness over a given set of PendingTurn entries — the policy, with
 * the collection passed in (the public call passes every contribution). */
export async function readinessOn(
  exec: DbExecutor,
  conversationId: string,
  entries: readonly PendingTurnEntry[],
  own: PendingTurnEntry | undefined,
): Promise<TurnReadiness> {
  const [row] = await exec
    .select({
      status: _conversations.status,
      waitingFor: _conversations.waitingFor,
    })
    .from(_conversations)
    .where(eq(_conversations.id, conversationId))
    .limit(1);
  if (row === undefined) return { kind: "not-found" };
  if (isAgentBusy(row.status)) return { kind: "held", reason: "busy" };
  if (row.waitingFor !== null) return { kind: "held", reason: "waiting-for" };
  for (const entry of entries) {
    if (entry.id === own?.id) continue;
    if (await entry.pending(conversationId, exec))
      return { kind: "held", reason: "pending-turn", by: entry.id };
  }
  return { kind: "ready" };
}

/**
 * May an automatic sender type its turn into `conversationId` now? The one
 * answer every automatic sender asks, so they cannot race each other into a
 * busy CLI. A sender that is itself a PendingTurn contributor passes its entry
 * as `own`, so its own pending turn does not hold it.
 */
export async function automaticTurnReadiness(
  conversationId: string,
  opts: { own?: PendingTurnEntry; exec?: DbExecutor } = {},
): Promise<TurnReadiness> {
  return readinessOn(
    opts.exec ?? db,
    conversationId,
    PendingTurn.getContributions(),
    opts.own,
  );
}
