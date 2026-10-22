import {
  QuestionHolds,
  type QuestionHold,
} from "@plugins/conversations/server";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@plugins/database/server";
import type { RelayState } from "../../core/schemas";
import { _pendingQuestions as t } from "../../server/internal/tables";

// The relay as a question-hold source for the status reconciler: a
// conversation's LATEST held question decides. `open` with a live holder is a
// question waiting; an open row whose holder died is absent here and retired by
// `reap`.
export const relayQuestionHolds = QuestionHolds.define({
  async read(ids) {
    const holds = new Map<string, QuestionHold>();
    for (const row of await latestHolds(ids)) {
      if (row.state === "open" && isPidAlive(row.relayPid)) {
        holds.set(row.conversationId, "open");
      }
    }
    return holds;
  },
  async reap(ids) {
    await abandonDeadHolds(ids);
  },
});

/** Is `pid` a live process on this host? */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // EPERM: it exists, owned by someone else.
    if (code === "EPERM") return true;
    if (code === "ESRCH") return false;
    throw err;
  }
}

/** Each conversation's LATEST held question (state + holder). */
export async function latestHolds(
  conversationIds: readonly string[],
): Promise<{ conversationId: string; state: RelayState; relayPid: number }[]> {
  return db
    .selectDistinctOn([t.conversationId], {
      conversationId: t.conversationId,
      state: t.state,
      relayPid: t.relayPid,
    })
    .from(t)
    .where(inArray(t.conversationId, [...conversationIds]))
    .orderBy(t.conversationId, desc(t.createdAt));
}

/**
 * Retire the open questions of `conversationIds` whose holder is gone. Returns
 * the retired rows.
 */
export async function abandonDeadHolds(
  conversationIds: readonly string[],
): Promise<{ toolUseId: string }[]> {
  const open = await db
    .select({ toolUseId: t.toolUseId, relayPid: t.relayPid })
    .from(t)
    .where(
      and(inArray(t.conversationId, [...conversationIds]), eq(t.state, "open")),
    );
  const dead = open.filter((r) => !isPidAlive(r.relayPid));
  if (dead.length === 0) return [];
  return db
    .update(t)
    .set({ state: "abandoned", resolvedAt: sql`now()` })
    .where(
      and(
        inArray(
          t.toolUseId,
          dead.map((r) => r.toolUseId),
        ),
        eq(t.state, "open"),
      ),
    )
    .returning({ toolUseId: t.toolUseId });
}
