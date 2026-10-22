import { and, eq, inArray, ne } from "drizzle-orm";
import { db } from "@plugins/database/server";
import { _conversations } from "@plugins/tasks/plugins/tasks-core/server";
import { EMPTY_PROJECTION, type AgentProjection } from "./reducer";
import { sdkAgents } from "./tables";

// The sdk runtime's reads and writes of this backend's DB.

const LIVE_STATUSES = ["starting", "working", "waiting"] as const;

/**
 * This DB's sdk conversations a process may be running for (starting, working
 * or waiting) — of `ids` when given, else all of them.
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

/** Whether `id` is one of this DB's sdk conversations, in any status. */
export async function isSdkConversation(id: string): Promise<boolean> {
  const [row] = await db
    .select({ runtime: _conversations.runtime })
    .from(_conversations)
    .where(eq(_conversations.id, id));
  return row?.runtime === "sdk";
}

export interface AgentRow extends AgentProjection {
  worktreePath: string;
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

/** Write the projection after a batch of lines, cursor included, in one statement. */
export async function writeProjection(
  id: string,
  state: AgentProjection,
): Promise<void> {
  await sdkAgents.update(id, state);
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
