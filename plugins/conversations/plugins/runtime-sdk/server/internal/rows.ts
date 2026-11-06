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

/**
 * The agent's row read from the DB, or null before its first `create`. Only
 * the machine's row lease (`machine/internal/agent-row-lease.ts`) calls it: it
 * is the row's one writer and holds the current row, so any other read goes
 * through it.
 */
export async function readAgentRow(id: string): Promise<AgentRow | null> {
  const row = await sdkAgents.get(id);
  return row ? agentRowOf(row) : null;
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
  for (const row of rows) out.set(row.conversationId, agentRowOf(row));
  return out;
}

type StoredRow = NonNullable<Awaited<ReturnType<typeof sdkAgents.get>>>;

function agentRowOf(row: StoredRow): AgentRow {
  const { conversationId: _id, createdAt: _c, updatedAt: _u, ...rest } = row;
  return rest;
}

/**
 * Write `patch` to the agent's row and answer the row as written — null when
 * there is none (its conversation was deleted). One statement, so a batch's
 * projection, cursor and read position land together and a restart reads on
 * from exactly the line after the cursor.
 */
export async function updateAgentRow(
  id: string,
  patch: Partial<AgentRow>,
): Promise<AgentRow | null> {
  const row = await sdkAgents.update(id, patch);
  return row ? agentRowOf(row) : null;
}

/**
 * A fresh row: the empty projection, the cursor at 0, no read position — what
 * an agent whose events file is gone starts from (it numbers from 1 again).
 */
export async function resetAgentRow(
  id: string,
  worktreePath: string,
  sessionId: string,
): Promise<AgentRow> {
  const row = await sdkAgents.upsert(id, {
    ...EMPTY_PROJECTION,
    eventsPosition: null,
    sessionId,
    worktreePath,
  });
  return agentRowOf(row);
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

/** Each of `ids`' attempt; a conversation this DB has no row of is absent. */
export async function attemptsOfConversations(
  ids: readonly string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (ids.length === 0) return out;
  const rows = await db
    .select({ id: _conversations.id, attemptId: _conversations.attemptId })
    .from(_conversations)
    .where(inArray(_conversations.id, [...ids]));
  for (const row of rows) out.set(row.id, row.attemptId);
  return out;
}

/** Every conversation of `attemptIds`, whatever its status. */
export async function conversationIdsOfAttempts(
  attemptIds: readonly string[],
): Promise<string[]> {
  if (attemptIds.length === 0) return [];
  const rows = await db
    .select({ id: _conversations.id })
    .from(_conversations)
    .where(inArray(_conversations.attemptId, [...attemptIds]));
  return rows.map((r) => r.id);
}

/** Each of `attemptIds`' workspace spec; an attempt this DB has no row of is absent. */
export async function workspacesOfAttempts(attemptIds: readonly string[]) {
  const rows =
    attemptIds.length === 0
      ? []
      : await db
          .select({ id: _attempts.id, workspace: _attempts.workspace })
          .from(_attempts)
          .where(inArray(_attempts.id, [...attemptIds]));
  return new Map(rows.map((r) => [r.id, r.workspace]));
}
