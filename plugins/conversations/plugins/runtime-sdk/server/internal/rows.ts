import { and, eq, inArray, isNotNull, ne } from "drizzle-orm";
import { db } from "@plugins/database/server";
import {
  _attempts,
  _conversations,
  _tasks,
} from "@plugins/tasks/plugins/tasks-core/server";
import { USAGE_LIMIT_ERROR } from "../../core";
import { EMPTY_PROJECTION, type AgentProjection } from "./reducer";
import type { ReadPosition } from "./read-position";
import { sdkAgents } from "./tables";

// The sdk runtime's reads and writes of this backend's DB.

const LIVE_STATUSES = ["starting", "working", "waiting"] as const;

/**
 * This DB's sdk conversations whose row expects a process (starting, working
 * or waiting) — of `ids` when given, else all of them. What the events consumer
 * catches up at boot; never the runtime's liveness (`sdkConversationIdsOf` +
 * the agent's pid file is).
 */
export async function liveSdkConversationIds(
  ids?: readonly string[],
): Promise<string[]> {
  if (ids && ids.length === 0) return [];
  const rows = await db
    .select({ id: _conversations.id })
    .from(_conversations)
    .where(
      and(
        eq(_conversations.runtime, "sdk"),
        inArray(_conversations.status, [...LIVE_STATUSES]),
        ...(ids ? [inArray(_conversations.id, [...ids])] : []),
      ),
    );
  return rows.map((r) => r.id);
}

/**
 * Of `ids`, this DB's sdk conversations, in any status. Which of them has a
 * process is the runtime's question (the agent's pid file), never the row's
 * status: the status is what the reconciler derives FROM that answer, so
 * reading it here would let a stale `gone` hide a running agent forever.
 */
export async function sdkConversationIdsOf(
  ids: readonly string[],
): Promise<string[]> {
  if (ids.length === 0) return [];
  const rows = await db
    .select({ id: _conversations.id })
    .from(_conversations)
    .where(
      and(
        eq(_conversations.runtime, "sdk"),
        inArray(_conversations.id, [...ids]),
      ),
    );
  return rows.map((r) => r.id);
}

/** Whether `id` is one of this DB's sdk conversations, in any status. */
export async function isSdkConversation(id: string): Promise<boolean> {
  const [row] = await db
    .select({ runtime: _conversations.runtime })
    .from(_conversations)
    .where(eq(_conversations.id, id));
  return row?.runtime === "sdk";
}

/**
 * What a person would call the conversation: its own title, else its task's;
 * null when it has neither (a conversation with no attempt, before titling).
 */
export async function conversationDisplayTitle(
  id: string,
): Promise<string | null> {
  const [row] = await db
    .select({ own: _conversations.title, task: _tasks.title })
    .from(_conversations)
    .leftJoin(_attempts, eq(_conversations.attemptId, _attempts.id))
    .leftJoin(_tasks, eq(_attempts.taskId, _tasks.id))
    .where(eq(_conversations.id, id))
    .limit(1);
  return row?.own ?? row?.task ?? null;
}

/**
 * This DB's active sdk conversations a usage limit stopped and that have run
 * no turn since — the `runtime-sdk.error-stopped` rows whose error is a usage
 * limit, with when it stopped them (epoch ms). What auto-resume resumes.
 */
export async function usageLimitStoppedConversations(): Promise<
  { id: string; stoppedAt: number }[]
> {
  const rows = await db
    .select({ id: _conversations.id, stoppedAt: sdkAgents.table.stoppedAt })
    .from(_conversations)
    .innerJoin(
      sdkAgents.table,
      eq(sdkAgents.table.conversationId, _conversations.id),
    )
    .where(
      and(
        eq(_conversations.runtime, "sdk"),
        inArray(_conversations.status, [...LIVE_STATUSES]),
        isNotNull(sdkAgents.table.stoppedAt),
        eq(sdkAgents.table.stopError, USAGE_LIMIT_ERROR),
      ),
    );
  return rows.flatMap((r) =>
    r.stoppedAt ? [{ id: r.id, stoppedAt: r.stoppedAt.getTime() }] : [],
  );
}

export interface AgentRow extends AgentProjection {
  worktreePath: string;
  /** Where in the events file the cursor was read up to; null before the first write. */
  eventsPosition: ReadPosition | null;
}

/** The agent's row, or null before its first `create`. */
export async function readAgentRow(id: string): Promise<AgentRow | null> {
  const row = await sdkAgents.get(id);
  if (!row) return null;
  const { conversationId: _id, createdAt: _c, updatedAt: _u, ...rest } = row;
  return rest;
}

/** Many agents' rows at once, keyed by conversation id. */
export async function readAgentRows(
  ids: readonly string[],
): Promise<Map<string, AgentRow>> {
  const out = new Map<string, AgentRow>();
  if (ids.length === 0) return out;
  const rows = await db
    .select()
    .from(sdkAgents.table)
    .where(inArray(sdkAgents.table.conversationId, [...ids]));
  for (const row of rows) {
    const { conversationId, createdAt: _c, updatedAt: _u, ...rest } = row;
    out.set(conversationId, rest);
  }
  return out;
}

/**
 * The row a `create` starts from: the existing one with its workspace path
 * (the cursor and projection carry on — a restarted agent continues its
 * predecessor's numbering), or a fresh one. `eventsExist: false` — the agent's
 * directory has no event file at all (reclaimed, or never written) — resets
 * the cursor, since the agent will number from 1 again. Either way the row
 * names the session the launch runs under (`AgentLaunchOptions.sessionId`), so
 * the conversation has its transcript from launch on.
 */
export async function prepareAgentRow(
  id: string,
  worktreePath: string,
  eventsExist: boolean,
  sessionId: string,
): Promise<void> {
  const existing = await readAgentRow(id);
  if (existing && eventsExist) {
    await sdkAgents.update(id, { worktreePath, sessionId });
    return;
  }
  await sdkAgents.upsert(id, {
    ...EMPTY_PROJECTION,
    eventsPosition: null,
    sessionId,
    worktreePath,
  });
}

/** A relaunch under another session (a rewind of the session's first turn). */
export async function recordLaunchSession(
  id: string,
  sessionId: string,
): Promise<void> {
  await sdkAgents.update(id, { sessionId });
}

/**
 * Write the projection after a batch of lines, cursor and the read position
 * after its last line included, in one statement — so a restart reads on from
 * exactly the line after the cursor.
 */
export async function writeProjection(
  id: string,
  state: AgentProjection,
  eventsPosition: ReadPosition | null,
): Promise<void> {
  await sdkAgents.update(id, { ...state, eventsPosition });
}

/** The attempt conversation `id` belongs to. Throws for an unknown conversation. */
export async function attemptOfConversation(id: string): Promise<string> {
  const [row] = await db
    .select({ attemptId: _conversations.attemptId })
    .from(_conversations)
    .where(eq(_conversations.id, id));
  if (!row) throw new Error(`Unknown conversation "${id}"`);
  return row.attemptId;
}

/** Whether any conversation of `attemptId` is still open (not closed: `done`). */
export async function attemptHasOpenConversation(
  attemptId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: _conversations.id })
    .from(_conversations)
    .where(
      and(
        eq(_conversations.attemptId, attemptId),
        ne(_conversations.status, "done"),
      ),
    )
    .limit(1);
  return row !== undefined;
}
