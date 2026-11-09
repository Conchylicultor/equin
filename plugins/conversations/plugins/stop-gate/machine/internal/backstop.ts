import { eq } from "drizzle-orm";
import { db, type DbExecutor } from "@plugins/database/server";
import {
  turnIdKind,
  type TurnId,
  type TurnKind,
} from "@plugins/conversations/plugins/turn-ledger/core";
import type {
  HeldTurn,
  TurnReadiness,
} from "@plugins/conversations/plugins/automatic-turn/server";
import type { ConversationStatus } from "@plugins/tasks/plugins/tasks-core/core";
import type { StopGateResponse } from "../../core";
import { _stopGateReminders } from "../../server/internal/tables";

// The Stop hook is a nudge at the moment an agent stops, and it fails open:
// with its backend unreachable for 15 s (main crash-looping), or on the
// second stop of one attempt (one forced continuation, never a loop), the
// agent stops with the gate's demand unmet and nothing recorded. Two
// supervisor workers did exactly that — their outcome-report submit failed
// with ECONNRESET during main's crash loop, the hook could not ask, and their
// tasks sat `need_action` for 11 h with nothing retried or flagged
// (task-1793988265-l0ilx4, task-1793988646-g26vcm).
//
// So the backend asks the same decision again once the agent HAS stopped, on
// the conversation's status change — a durable trigger, so a backend that was
// down when the agent stopped still runs it when it is back. Bounded: one
// reminder turn per conversation (`stop_gate_reminders`' PK); a conversation
// that stops again with the demand still unmet — or that can take no turn
// (its agent gone) — is flagged to the user instead. Never a loop.

/** The conversation as the backstop reads it. */
export interface StoppedConversation {
  id: string;
  status: ConversationStatus;
  /** When `status` last changed — `null` on a row from before it was kept. */
  statusSince: Date | null;
  taskId: string;
  taskTitle: string;
}

/** What the backstop reads and does outside its table: ports, so a test
 * drives the policy over the real table with a fake agent. */
export interface BackstopPorts {
  conversation(conversationId: string): Promise<StoppedConversation | null>;
  /** The stop decision, from every gate and waiver (`evaluateStop`). */
  decide(conversationId: string): Promise<StopGateResponse>;
  /** Whether an automatic turn may be typed now (conversations/automatic-turn). */
  readiness(conversationId: string, exec: DbExecutor): Promise<TurnReadiness>;
  /** Submit one turn (idempotent on `turnId`). */
  submit(
    conversationId: string,
    turn: { id: TurnId; kind: TurnKind; text: string },
  ): Promise<void>;
  /** Tell the user the conversation stopped with `reason` unmet. */
  flag(conversation: StoppedConversation, reason: string): Promise<void>;
}

export type BackstopOutcome =
  | { kind: "none" }
  /** The agent cannot take a turn now; its next status change re-runs this. */
  | HeldTurn
  | { kind: "reminded" }
  | { kind: "flagged" };

/** The reminder turn: why it comes now, then what the gates said. */
export function reminderText(reason: string): string {
  return `You stopped while a stop gate would have blocked you — it could not be asked (the app was unreachable), or you stopped again after it did:\n\n${reason}`;
}

/**
 * Re-ask the stop decision for a conversation whose agent stopped, and act on
 * a `block` the hook did not enforce. Called on each of its status changes:
 *
 * - `waiting` (its turn ended, the agent is up): no reminder yet → record one
 *   and type it as an event turn. A reminder recorded, and the agent has run
 *   since (its status moved after it) → it stopped again with the demand
 *   unmet: flag. Not run since → the reminder may not have gone out (a
 *   retried job): re-submit the same turn, which no-ops if it did.
 * - `gone` / `done` (no agent to type into — an event turn resumes none):
 *   flag.
 * - Busy (`starting` / `working`): nothing — it has not stopped.
 */
export async function backstopStop(
  conversationId: string,
  ports: BackstopPorts,
  exec: DbExecutor = db,
): Promise<BackstopOutcome> {
  const conversation = await ports.conversation(conversationId);
  if (conversation === null) return { kind: "none" };
  const stopped =
    conversation.status === "waiting" ||
    conversation.status === "gone" ||
    conversation.status === "done";
  if (!stopped) return { kind: "none" };
  const decision = await ports.decide(conversationId);
  if (decision.decision === "allow") return { kind: "none" };
  const reason = decision.reason ?? "A stop gate blocked this stop.";
  if (conversation.status !== "waiting") {
    await ports.flag(conversation, reason);
    return { kind: "flagged" };
  }
  const readiness = await ports.readiness(conversationId, exec);
  if (readiness.kind === "not-found") return { kind: "none" };
  if (readiness.kind === "held") return readiness;

  const [existing] = await exec
    .select()
    .from(_stopGateReminders)
    .where(eq(_stopGateReminders.conversationId, conversationId))
    .limit(1);
  let turnId: string;
  if (existing === undefined) {
    const [inserted] = await exec
      .insert(_stopGateReminders)
      .values({ conversationId, turnId: turnIdKind.mint() })
      .onConflictDoNothing()
      .returning();
    // A concurrent run recorded it first, and sends it.
    if (inserted === undefined) return { kind: "none" };
    turnId = inserted.turnId;
  } else {
    const since = conversation.statusSince;
    if (since !== null && since > existing.sentAt) {
      await ports.flag(conversation, reason);
      return { kind: "flagged" };
    }
    turnId = existing.turnId;
  }
  await ports.submit(conversationId, {
    id: turnIdKind.parse(turnId),
    kind: "event",
    text: reminderText(reason),
  });
  return { kind: "reminded" };
}
