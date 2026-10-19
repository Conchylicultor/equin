import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@plugins/database/server";
import { HttpError } from "@plugins/infra/plugins/endpoints/server";
import { _conversations } from "@plugins/tasks/plugins/tasks-core/server";
import type {
  CliAnswer,
  RegisterQuestionBody,
  RelayResolution,
  RelayState,
} from "../../core/schemas";
import { _pendingQuestions } from "./tables";

const t = _pendingQuestions;

type Row = typeof t.$inferSelect;

function resolutionOf(row: Pick<Row, "state" | "answer">): RelayResolution {
  switch (row.state) {
    case "answered":
      if (!row.answer) {
        throw new Error("pending_questions: an answered row without an answer");
      }
      return { state: "answered", answer: row.answer };
    case "open":
    case "released":
    case "abandoned":
      return { state: row.state };
  }
}

/** The row of `toolUseId` in `conversationId`, or 404. */
async function requireRow(
  conversationId: string,
  toolUseId: string,
): Promise<Row> {
  const [row] = await db
    .select()
    .from(t)
    .where(
      and(eq(t.toolUseId, toolUseId), eq(t.conversationId, conversationId)),
    );
  if (!row) {
    throw new HttpError(
      404,
      `no held question ${toolUseId} in conversation ${conversationId}`,
    );
  }
  return row;
}

/**
 * Upsert the held question. A re-registration (the relay reconnecting after a
 * restart) only refreshes the holder's pid, and only while the question is
 * still open; either way it answers where the question stands.
 */
export async function registerQuestion(
  conversationId: string,
  body: RegisterQuestionBody,
): Promise<RelayResolution> {
  const [conversation] = await db
    .select({ id: _conversations.id })
    .from(_conversations)
    .where(eq(_conversations.id, conversationId));
  if (!conversation) {
    throw new HttpError(404, `no conversation ${conversationId}`);
  }
  await db
    .insert(t)
    .values({
      toolUseId: body.toolUseId,
      conversationId,
      questions: body.questions,
      relayPid: body.pid,
      state: "open",
    })
    .onConflictDoUpdate({
      target: t.toolUseId,
      set: { relayPid: sql`excluded.relay_pid` },
      setWhere: and(eq(t.state, "open"), eq(t.conversationId, conversationId)),
    });
  return resolutionOf(await requireRow(conversationId, body.toolUseId));
}

export async function readResolution(
  conversationId: string,
  toolUseId: string,
): Promise<RelayResolution> {
  return resolutionOf(await requireRow(conversationId, toolUseId));
}

export async function readOpenQuestions(
  conversationId: string,
  toolUseId: string,
): Promise<Row> {
  const row = await requireRow(conversationId, toolUseId);
  if (row.state !== "open") {
    throw new HttpError(409, `the question is no longer open (${row.state})`);
  }
  return row;
}

/**
 * Move an open question to `to`. 409 when it already left `open` — two
 * answers racing, or an answer after "Answer in terminal".
 */
export async function resolveQuestion(
  conversationId: string,
  toolUseId: string,
  to: Exclude<RelayState, "open">,
  answer: CliAnswer | null = null,
): Promise<void> {
  const updated = await db
    .update(t)
    .set({ state: to, answer, resolvedAt: sql`now()` })
    .where(
      and(
        eq(t.toolUseId, toolUseId),
        eq(t.conversationId, conversationId),
        eq(t.state, "open"),
      ),
    )
    .returning({ toolUseId: t.toolUseId });
  if (updated.length === 0) {
    const row = await requireRow(conversationId, toolUseId);
    throw new HttpError(409, `the question is no longer open (${row.state})`);
  }
}

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
 * Retire the open questions of `conversationIds` whose relay is gone. Returns
 * the retired rows (to wake their awaits).
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

/**
 * Release every open question of `conversationIds` (the user is sending a
 * message instead of answering). Returns the released rows (to wake their
 * awaits).
 */
export async function releaseOpenHolds(
  conversationIds: readonly string[],
): Promise<{ toolUseId: string }[]> {
  return db
    .update(t)
    .set({ state: "released", resolvedAt: sql`now()` })
    .where(
      and(inArray(t.conversationId, [...conversationIds]), eq(t.state, "open")),
    )
    .returning({ toolUseId: t.toolUseId });
}

/**
 * Retire one question if it is still open — its holder stopped waiting without
 * the web answering (the agent dismissed or withdrew it). Returns whether it
 * was open.
 */
export async function abandonIfOpen(
  conversationId: string,
  toolUseId: string,
): Promise<boolean> {
  const rows = await db
    .update(t)
    .set({ state: "abandoned", resolvedAt: sql`now()` })
    .where(
      and(
        eq(t.toolUseId, toolUseId),
        eq(t.conversationId, conversationId),
        eq(t.state, "open"),
      ),
    )
    .returning({ toolUseId: t.toolUseId });
  return rows.length > 0;
}
