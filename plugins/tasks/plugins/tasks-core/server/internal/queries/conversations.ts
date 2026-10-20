import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lt,
  ne,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { db } from "@plugins/database/server";
import { _conversations, _tasks } from "../tables";
import { conversations } from "../views";
import type { Conversation } from "../schema";
import { RECENT_GONE_LIMIT } from "../../../core";

// Re-exported so server-side callers keep importing it from the queries module
// (its canonical source moved to tasks-core/core for client derivation).
export { RECENT_GONE_LIMIT };

// The model column tolerates legacy/unknown values on parse via the
// `tolerantEnum` field in ConversationSchema, so reads need no normalization.

// System conversations (machine-spawned automation) live in the same table but
// never surface in the sidebar, recovery pane, or attempt-view — they're
// plumbing. Only `listConversationsForInfra` opts out of this filter; every
// other entry point excludes them.
const notSystem = ne(conversations.kind, "system");

// Conversations of a *held* task, whatever their own status. Holding is the user
// saying "I am coming back to this", and the canonical "Hold & close" flow closes
// every conversation on the way — so `active` alone excludes exactly the rows a
// hold means to preserve. Built per call rather than hoisted to module scope so
// `db` is never touched at import time.
function onHeldTask(): SQL {
  return inArray(
    conversations.taskId,
    db.select({ id: _tasks.id }).from(_tasks).where(isNotNull(_tasks.heldAt)),
  );
}

type Filters = {
  includeSystem?: boolean;
  onlySystem?: boolean;
  active?: boolean;
  activeOrHeldTask?: boolean;
  taskIds?: readonly string[];
  convIds?: readonly string[];
};

function buildWhere(f: Filters): SQL | undefined {
  const clauses: SQL[] = [];
  if (f.onlySystem) clauses.push(eq(conversations.kind, "system"));
  else if (!f.includeSystem) clauses.push(notSystem);
  if (f.active !== undefined) clauses.push(eq(conversations.active, f.active));
  if (f.activeOrHeldTask)
    clauses.push(or(eq(conversations.active, true), onHeldTask())!);
  if (f.taskIds) clauses.push(inArray(conversations.taskId, [...f.taskIds]));
  if (f.convIds) clauses.push(inArray(conversations.id, [...f.convIds]));
  return clauses.length ? and(...clauses) : undefined;
}

type Order = {
  col: typeof conversations.createdAt;
  dir: "asc" | "desc";
};

function queryConversations(
  filters: Filters,
  order: Order,
  limit?: number,
): Promise<Conversation[]> {
  const orderExpr = order.dir === "asc" ? asc(order.col) : desc(order.col);
  const base = db
    .select()
    .from(conversations)
    .where(buildWhere(filters))
    .orderBy(orderExpr);
  const q = limit !== undefined ? base.limit(limit) : base;
  return q;
}

// Infra paths only: the conversations status reconciler; turn-emitter boot
// reconcile. Returns active (non-`done`) rows including system kinds so tmux
// death is detected and turn events are emitted for system conversations.
//
// Scoped to `active` (status <> 'done') because both callers only ever act on
// non-terminal rows: the reconciler already skips done/gone, and the
// turn-emitter filters `isActiveStatus` (= status !== 'done'). `gone` rows are
// retained so the reconciler's resurrection path still sees them. Without this
// filter the query scans every conversation ever created (unbounded history
// growth) on every reconcile. UI must never call this.
//
// `scope` narrows the read to what one push signal names: a set of
// conversation ids (a PK read).
export function listConversationsForInfra(scope?: {
  ids: readonly string[];
}): Promise<Conversation[]> {
  if (scope && scope.ids.length === 0) return Promise.resolve([]);
  const order = { col: conversations.createdAt, dir: "desc" } as const;
  return queryConversations(
    {
      includeSystem: true,
      active: true,
      ...(scope ? { convIds: scope.ids } : {}),
    },
    order,
  );
}

// User-visible list, newest-first. Sidebar / list endpoint. Pass `taskIds` to
// scope to just those tasks' conversations; omit it for the full list.
export function listConversationsForDisplay(
  taskIds?: readonly string[],
): Promise<Conversation[]> {
  return queryConversations(
    { taskIds },
    { col: conversations.createdAt, dir: "desc" },
  );
}

// User-visible + active=true. Server-side batch callers (backup, transcript
// retention, cross-table mutations). The conversations-active/-system live-state
// resources no longer route through here — they are `liveCollection`s declared
// `all` (see ../conversation-rows.ts), so this needs no scoped-recompute id
// parameter.
export function listActiveConversations(): Promise<Conversation[]> {
  return queryConversations(
    { active: true },
    { col: conversations.createdAt, dir: "desc" },
  );
}

// User-visible rows whose Claude JSONL transcript must be kept alive: every
// active conversation, PLUS every conversation of a held task regardless of its
// own status. Read by the transcript-touch job (conversations/transcript-
// retention), which refreshes each file's mtime so Claude Code's
// `cleanupPeriodDays` sweep never deletes it — transcripts are the sole source
// of truth for conversation content, so aging one out erases the history.
// `listActiveConversations` is the wrong scope there: a held task is parked, not
// finished, and its conversations are `done` by construction (Hold & close).
export function listRetainedConversations(): Promise<Conversation[]> {
  return queryConversations(
    { activeOrHeldTask: true },
    { col: conversations.createdAt, dir: "desc" },
  );
}

// Every conversation id of one attempt — INCLUDING system kinds, unlike every
// other entry point here. The consumer (attempt-work) greps `main` for commits
// carrying a `Singularity-Conversation` trailer in this set, and a commit authored
// by a machine-spawned conversation is still that attempt's landed work: an
// omitted id would read as "nothing landed", which is exactly the false negative
// the git-derived standing exists to remove.
//
// Read off the `conversations` TABLE, not `conversations_v`: the set is the
// same (the view inner-joins the attempt, and `attempt_id` is a NOT NULL FK),
// but a live loader reading it (attempt-work's) would otherwise capture the
// view's whole read-set — `tasks` and `attempts` included — and recompute
// (git work) on every task write.
export async function listConversationIdsForAttempt(
  attemptId: string,
): Promise<string[]> {
  const rows = await db
    .select({ id: _conversations.id })
    .from(_conversations)
    .where(eq(_conversations.attemptId, attemptId));
  return rows.map((r) => r.id);
}

// Idle-kill candidates: waiting, not already hibernated, resumable (has a
// saved Claude session), and idle since `before` (lastViewedAt, or createdAt
// when never viewed). Used by the conversations.hibernate-idle job.
export function listHibernationCandidates(
  before: Date,
): Promise<{ id: string }[]> {
  return db
    .select({ id: conversations.id })
    .from(conversations)
    .where(
      and(
        eq(conversations.status, "waiting"),
        isNull(conversations.hibernatedAt),
        isNotNull(conversations.claudeSessionId),
        lt(
          sql`coalesce(${conversations.lastViewedAt}, ${conversations.createdAt})`,
          before,
        ),
      ),
    );
}

export async function getConversation(
  id: string,
): Promise<Conversation | null> {
  const [row] = await db
    .select()
    .from(conversations)
    .where(eq(conversations.id, id))
    .limit(1);
  return row ?? null;
}

// Reads only the columns needed by the runtime (no join, no derived fields).
export async function getConversationRuntime(id: string): Promise<{
  status: Conversation["status"];
  runtime: string;
  claudeSessionId: string | null;
  waitingFor: string | null;
} | null> {
  const [row] = await db
    .select({
      status: _conversations.status,
      runtime: _conversations.runtime,
      claudeSessionId: _conversations.claudeSessionId,
      waitingFor: _conversations.waitingFor,
    })
    .from(_conversations)
    .where(eq(_conversations.id, id))
    .limit(1);
  return row ?? null;
}

// Returns claudeSessionId for transcript lookup. Returns `undefined` when the
// conversation row does not exist (vs `null` when it exists but has no session).
export async function getConversationClaudeSessionId(
  id: string,
): Promise<string | null | undefined> {
  const [row] = await db
    .select({ claudeSessionId: _conversations.claudeSessionId })
    .from(_conversations)
    .where(eq(_conversations.id, id))
    .limit(1);
  if (!row) return undefined;
  return row.claudeSessionId;
}
