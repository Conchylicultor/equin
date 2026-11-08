import {
  and,
  eq,
  exists,
  getTableColumns,
  inArray,
  isNotNull,
  ne,
  sql,
} from "drizzle-orm";
import { db, writeAtomically } from "@plugins/database/server";
import {
  _attempts,
  _conversations,
  _tasks,
} from "@plugins/tasks/plugins/tasks-core/server";
import { USAGE_LIMIT_ERROR } from "../../core";
import { EMPTY_PROJECTION, type AgentProjection } from "./reducer";
import type { ReadPosition } from "./read-position";
import { sdkAgentStops, sdkAgents } from "./tables";

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
    .select({
      id: _conversations.id,
      stoppedAt: sdkAgentStops.table.stoppedAt,
    })
    .from(_conversations)
    .innerJoin(
      sdkAgentStops.table,
      eq(sdkAgentStops.table.conversationId, _conversations.id),
    )
    .where(
      and(
        eq(_conversations.runtime, "sdk"),
        inArray(_conversations.status, [...LIVE_STATUSES]),
        isNotNull(sdkAgentStops.table.stoppedAt),
        eq(sdkAgentStops.table.stopError, USAGE_LIMIT_ERROR),
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
 * The projection's fields a live surface reads, stored in their own row
 * (`conversations_ext_sdk_agent_stop`, tables.ts) — the rest is the consumer's
 * private checkpoint, outside the change feed.
 */
const STOP_FIELDS = ["stoppedAt", "stopError", "account"] as const;
type StopFields = Pick<AgentRow, (typeof STOP_FIELDS)[number]>;
const NO_STOP: StopFields = { stoppedAt: null, stopError: null, account: null };

function sameStop(a: StopFields, b: StopFields): boolean {
  return (
    a.stoppedAt?.getTime() === b.stoppedAt?.getTime() &&
    a.stopError === b.stopError &&
    a.account === b.account
  );
}

/** `patch` without the stop fields: what goes to the checkpoint row. */
function checkpointPatch(
  patch: Partial<AgentRow>,
): Omit<Partial<AgentRow>, (typeof STOP_FIELDS)[number]> {
  const { stoppedAt: _s, stopError: _e, account: _a, ...rest } = patch;
  return rest;
}

// A stop field reads NULL where the agent has no stop row (the LEFT join): the
// empty projection's value for each of them.
const agentRowColumns = {
  ...getTableColumns(sdkAgents.table),
  stoppedAt: sdkAgentStops.table.stoppedAt,
  stopError: sdkAgentStops.table.stopError,
  account: sdkAgentStops.table.account,
};

/** The checkpoint row with its stop row (when it has one) joined. */
function selectAgentRows() {
  return db
    .select(agentRowColumns)
    .from(sdkAgents.table)
    .leftJoin(
      sdkAgentStops.table,
      eq(sdkAgentStops.table.conversationId, sdkAgents.table.conversationId),
    );
}

/**
 * The agent's row read from the DB, or null before its first `create`. Only
 * the machine's row lease (`machine/internal/agent-row-lease.ts`) calls it: it
 * is the row's one writer and holds the current row, so any other read goes
 * through it.
 */
export async function readAgentRow(id: string): Promise<AgentRow | null> {
  const [row] = await selectAgentRows()
    .where(eq(sdkAgents.table.conversationId, id))
    .limit(1);
  return row ? agentRowOf(row) : null;
}

/** Many agents' rows at once, keyed by conversation id. */
export async function readAgentRows(
  ids: readonly string[],
): Promise<Map<string, AgentRow>> {
  const out = new Map<string, AgentRow>();
  if (ids.length === 0) return out;
  const rows = await selectAgentRows().where(
    inArray(sdkAgents.table.conversationId, [...ids]),
  );
  for (const row of rows) out.set(row.conversationId, agentRowOf(row));
  return out;
}

type CheckpointRow = NonNullable<Awaited<ReturnType<typeof sdkAgents.get>>>;
function agentRowOf(row: CheckpointRow & StopFields): AgentRow {
  const { conversationId: _id, createdAt: _c, updatedAt: _u, ...rest } = row;
  return rest;
}

/**
 * Write `patch` over the agent's row `prev` (as last written) and answer the
 * row as written — null when there is none (its conversation was deleted).
 * One statement, so a batch's projection, cursor and read position land
 * together and a restart reads on from exactly the line after the cursor. The
 * stop row is in that statement only when a stop field moved: a batch that
 * moved only the checkpoint writes nothing the change feed carries.
 */
export async function updateAgentRow(
  id: string,
  prev: AgentRow,
  patch: Partial<AgentRow>,
): Promise<AgentRow | null> {
  const checkpoint = checkpointPatch(patch);
  // A field the patch leaves undefined keeps its value, as drizzle's SET does.
  const stop: StopFields = {
    stoppedAt: patch.stoppedAt === undefined ? prev.stoppedAt : patch.stoppedAt,
    stopError: patch.stopError === undefined ? prev.stopError : patch.stopError,
    account: patch.account === undefined ? prev.account : patch.account,
  };
  if (sameStop(prev, stop)) {
    const row = await sdkAgents.update(id, checkpoint);
    return row ? agentRowOf({ ...row, ...stop }) : null;
  }
  const hasCheckpoint = Object.values(checkpoint).some((v) => v !== undefined);
  await writeAtomically(db, [
    hasCheckpoint
      ? db
          .update(sdkAgents.table)
          .set(checkpoint)
          .where(eq(sdkAgents.table.conversationId, id))
      : null,
    stopUpsert(id, stop),
  ]);
  return { ...prev, ...checkpoint, ...stop };
}

/**
 * The stop row's upsert, inserting only while the agent's checkpoint row
 * exists: a conversation deleted under its agent (the cascade took the
 * checkpoint) writes nothing rather than failing the stop row's foreign key,
 * and its next checkpoint-only write answers null, as before the split.
 * Through the handle, so its SET list is the stop fields: the derived
 * `updated_at` (set by its touchedBy trigger, refused on a write) has no
 * spelling here.
 */
function stopUpsert(id: string, stop: StopFields) {
  return sdkAgentStops.upsertQuery(id, stop, {
    onlyIf: exists(
      db
        .select({ one: sql`1` })
        .from(sdkAgents.table)
        .where(eq(sdkAgents.table.conversationId, id)),
    ),
  });
}

/**
 * A fresh row: the empty projection, the cursor at 0, no read position — what
 * an agent whose events file is gone starts from (it numbers from 1 again). Its
 * stop row goes with it: the empty projection has no stop and no account.
 */
export async function resetAgentRow(
  id: string,
  worktreePath: string,
  sessionId: string,
): Promise<AgentRow> {
  const {
    stoppedAt: _s,
    stopError: _e,
    account: _a,
    ...checkpoint
  } = {
    ...EMPTY_PROJECTION,
    eventsPosition: null,
    sessionId,
    worktreePath,
  };
  await writeAtomically(db, [
    sdkAgents.upsertQuery(id, checkpoint),
    db
      .delete(sdkAgentStops.table)
      .where(eq(sdkAgentStops.table.conversationId, id)),
  ]);
  return { ...checkpoint, ...NO_STOP };
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
