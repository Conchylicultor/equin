import { and, eq } from "drizzle-orm";
import { db, type DbExecutor } from "@plugins/database/server";
import { turnIdKind } from "@plugins/conversations/plugins/turn-ledger/core";
import type {
  HeldTurn,
  PendingTurnEntry,
  TurnReadiness,
} from "@plugins/conversations/plugins/automatic-turn/server";
import { _conversationMandateNotices } from "./tables";

/**
 * What sending a notice reads and does outside its table: ports, so the
 * policy is driven over the real table with a fake agent.
 */
export interface NoticePorts {
  /** Whether this backend runs the conversation's agent (its own namespace). */
  running(conversationId: string): Promise<boolean>;
  /** Whether an automatic turn may be typed now (our own pending one excepted). */
  readiness(conversationId: string, exec: DbExecutor): Promise<TurnReadiness>;
  /** The `## Mandate` section a conversation starting now would be given. */
  mandateSection(conversationId: string): Promise<string | null>;
  /** Submit one event turn (idempotent on `id`). */
  submit(
    conversationId: string,
    turn: { id: string; text: string },
  ): Promise<void>;
}

export type NoticeOutcome =
  | { kind: "none" }
  /** The agent cannot take a turn now; its next status change re-runs this. */
  | HeldTurn
  | { kind: "sent" };

/**
 * The notice: the agent's MCP tools were already refreshed (reconnected), but
 * the server instructions it read at its start are not re-read, so this turn
 * carries their new `## Mandate` section.
 */
export function noticeText(section: string | null): string {
  return [
    "Your task's mandate was just changed by the user. Your equin MCP tools were refreshed to match; the `## Mandate` section of the equin server instructions you read when this conversation started is now out of date — follow this one instead:",
    "",
    section ??
      "## Mandate\n\nYour mandate grants nothing in this task's subtree.",
    "",
    "If you have work in progress, carry on under these rules. If you had nothing in progress, acknowledge in one line and stop.",
  ].join("\n");
}

/** Record that `conversationIds` are owed a notice (a pending one is replaced). */
export async function requestNotices(
  conversationIds: readonly string[],
  exec: DbExecutor = db,
): Promise<void> {
  for (const conversationId of conversationIds) {
    const row = {
      conversationId,
      turnId: turnIdKind.mint(),
      requestedAt: new Date(),
    };
    await exec
      .insert(_conversationMandateNotices)
      .values(row)
      .onConflictDoUpdate({
        target: _conversationMandateNotices.conversationId,
        set: row,
      });
  }
}

/**
 * A pending notice is a turn of ours waiting for the agent: every other
 * automatic sender holds until it went out, so the agent reads its new rules
 * before acting on an event. Contributed as `PendingTurn`.
 */
export const noticeTurn: PendingTurnEntry = {
  id: "mandate-change-notice",
  pending: async (conversationId, exec) => {
    const [row] = await exec
      .select({ id: _conversationMandateNotices.conversationId })
      .from(_conversationMandateNotices)
      .where(eq(_conversationMandateNotices.conversationId, conversationId))
      .limit(1);
    return row !== undefined;
  },
};

/**
 * Send `conversationId`'s pending notice, if its agent can take a turn. An
 * agent this backend does not run gets none — the row is dropped: its next
 * start connects afresh and reads the new mandate (and a forked DB's copy of
 * main's conversation must never start an agent here).
 */
export async function sendNotice(
  conversationId: string,
  ports: NoticePorts,
  exec: DbExecutor = db,
): Promise<NoticeOutcome> {
  const [row] = await exec
    .select()
    .from(_conversationMandateNotices)
    .where(eq(_conversationMandateNotices.conversationId, conversationId))
    .limit(1);
  if (row === undefined) return { kind: "none" };
  if (!(await ports.running(conversationId))) {
    await deleteNotice(conversationId, row.turnId, exec);
    return { kind: "none" };
  }
  const readiness = await ports.readiness(conversationId, exec);
  if (readiness.kind === "not-found") return { kind: "none" };
  if (readiness.kind === "held") return readiness;
  await ports.submit(conversationId, {
    id: row.turnId,
    text: noticeText(await ports.mandateSection(conversationId)),
  });
  await deleteNotice(conversationId, row.turnId, exec);
  return { kind: "sent" };
}

/** Only this notice: one requested while it went out is the next one. */
async function deleteNotice(
  conversationId: string,
  turnId: string,
  exec: DbExecutor,
): Promise<void> {
  await exec
    .delete(_conversationMandateNotices)
    .where(
      and(
        eq(_conversationMandateNotices.conversationId, conversationId),
        eq(_conversationMandateNotices.turnId, turnId),
      ),
    );
}
