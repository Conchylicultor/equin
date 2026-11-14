import { and, count, desc, eq, inArray, max, sql } from "drizzle-orm";
import { z } from "zod";
import { db, type DbExecutor } from "@plugins/database/server";
import { asPluginId } from "@plugins/framework/plugins/plugin-id/core";
import { defineJob } from "@plugins/infra/plugins/jobs/server";
import { submitTurn } from "@plugins/conversations/server";
import { DEFAULT_MODEL_CHOICE } from "@plugins/conversations/plugins/model-provider/core";
import {
  _attempts,
  _conversations,
} from "@plugins/tasks/plugins/tasks-core/server";
import {
  fileSystemBacklogTask,
  getSupervisorRole,
  liveSessionOf,
} from "@plugins/tasks/plugins/supervisor-roles/server";
import { openRoleSession } from "@plugins/tasks/plugins/supervisor-roles/plugins/sessions/server";
import {
  DEFAULT_GAP_MINUTES,
  DEFAULT_IDLE_POLICY,
  MESSAGES_KEPT_PER_ROLE,
  PENDING_PER_ROLE_MAX,
  eventMessageIdKind,
  nextMessageAt,
  pendingEventIdKind,
  renderEventMessage,
  type EventLine,
  type EventMessageId,
  type IdlePolicy,
  type MessageOutcome,
} from "../../core";
import {
  _supervisorEventMessages,
  _supervisorEventPending,
  _supervisorEventRoutes,
  _supervisorEventSettings,
  streamLabel,
} from "../../server";

const FILED_FROM = asPluginId("tasks.supervisor-roles.events");

/** The key the events past {@link PENDING_PER_ROLE_MAX} distinct ones fold into. */
const OTHER_KEY = "*other*";

/**
 * How long a flush that found the role's session not started yet (armed, its
 * agent still launching) waits before it looks again — bounded: the launch
 * is minutes at most, and nothing else would say when it is up.
 */
const SESSION_STARTING_RETRY_MS = 60_000;

/** One event a stream sends to whichever role it is routed to. */
export interface SupervisorEvent {
  /** The stream it belongs to (a `SupervisorEventStream` id). */
  stream: string;
  /** What makes two events the same one (a report's fingerprint): they fold into one line. */
  key: string;
  kind: string;
  /** One line saying what happened. */
  title: string;
  /** Where to read the whole event (a report id), if anywhere. */
  ref: string | null;
}

/** Serialize a role's gathering and sending. */
async function lockRoleEvents(roleId: string, exec: DbExecutor): Promise<void> {
  await exec.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext(${`supervisor-events:${roleId}`}))`,
  );
}

async function settingsOf(
  roleId: string,
  exec: DbExecutor,
): Promise<{ gapMinutes: number; idle: IdlePolicy }> {
  const [row] = await exec
    .select({
      gapMinutes: _supervisorEventSettings.gapMinutes,
      idle: _supervisorEventSettings.idle,
    })
    .from(_supervisorEventSettings)
    .where(eq(_supervisorEventSettings.roleId, roleId));
  return row ?? { gapMinutes: DEFAULT_GAP_MINUTES, idle: DEFAULT_IDLE_POLICY };
}

async function lastMessageAt(
  roleId: string,
  exec: DbExecutor,
): Promise<Date | null> {
  const [row] = await exec
    .select({ at: max(_supervisorEventMessages.sentAt) })
    .from(_supervisorEventMessages)
    .where(eq(_supervisorEventMessages.roleId, roleId));
  return row?.at ?? null;
}

/** When `roleId`'s gathered events go out, from its last message and its gap. */
async function dueAt(roleId: string, exec: DbExecutor): Promise<Date> {
  const { gapMinutes } = await settingsOf(roleId, exec);
  return nextMessageAt(
    await lastMessageAt(roleId, exec),
    gapMinutes * 60_000,
    new Date(),
  );
}

/**
 * Send `event` to the role its stream is routed to: gathered with the role's
 * other events of this quiet period, then sent by the role's flush job — at
 * once when the role's last message is older than its gap, else when the gap
 * ends. A stream routed nowhere, or a kind its route filters out, is ignored.
 *
 * Only gathers: delivery (which can fail) is always the flush job's, one per
 * role. So a failing delivery cannot feed itself — the report its failure
 * files is gathered like any other event (a count bump) and waits for the
 * same flush, and however many events land at once, one message goes per
 * quiet period.
 */
export async function publishSupervisorEvent(
  event: SupervisorEvent,
): Promise<void> {
  const due = await db.transaction(async (tx) => {
    const [route] = await tx
      .select()
      .from(_supervisorEventRoutes)
      .where(eq(_supervisorEventRoutes.streamId, event.stream));
    if (!route) return null;
    if (route.kinds !== null && !route.kinds.includes(event.kind)) return null;
    await lockRoleEvents(route.roleId, tx);
    await gather(route.roleId, event, tx);
    return { roleId: route.roleId, at: await dueAt(route.roleId, tx) };
  });
  if (due === null) return;
  await supervisorEventsFlushJob.enqueue(
    { roleId: due.roleId },
    { runAt: due.at },
  );
}

async function gather(
  roleId: string,
  event: SupervisorEvent,
  tx: DbExecutor,
): Promise<void> {
  const p = _supervisorEventPending;
  const bump = await tx
    .update(p)
    .set({
      count: sql`${p.count} + 1`,
      title: event.title,
      ref: event.ref,
      lastAt: new Date(),
    })
    .where(
      and(
        eq(p.roleId, roleId),
        eq(p.streamId, event.stream),
        eq(p.key, event.key),
      ),
    )
    .returning({ id: p.id });
  if (bump.length > 0) return;
  const [{ n } = { n: 0 }] = await tx
    .select({ n: count() })
    .from(p)
    .where(eq(p.roleId, roleId));
  // Past the cap, a new distinct event folds into one line per stream.
  const folded = n >= PENDING_PER_ROLE_MAX;
  const row = folded
    ? { key: OTHER_KEY, kind: "other", title: "other events", ref: null }
    : { key: event.key, kind: event.kind, title: event.title, ref: event.ref };
  await tx
    .insert(p)
    .values({
      id: pendingEventIdKind.mint(),
      roleId,
      streamId: event.stream,
      ...row,
      count: 1,
    })
    .onConflictDoUpdate({
      target: [p.roleId, p.streamId, p.key],
      set: { count: sql`${p.count} + 1`, lastAt: new Date() },
    });
}

/** The conversation a role's live session runs in now, or null before its agent started. */
async function sessionConversation(
  sessionTaskId: string,
  exec: DbExecutor,
): Promise<string | null> {
  const [row] = await exec
    .select({ id: _conversations.id })
    .from(_attempts)
    .innerJoin(_conversations, eq(_conversations.attemptId, _attempts.id))
    .where(eq(_attempts.taskId, sessionTaskId))
    .orderBy(desc(_conversations.createdAt), desc(_conversations.id))
    .limit(1);
  return row?.id ?? null;
}

/**
 * A message's lines, most frequent first, at most {@link PENDING_PER_ROLE_MAX}
 * + 1: past the cap (events put back by a failed delivery, or one "other"
 * line per stream) the tail folds into one "other" line.
 */
function capLines(lines: EventLine[]): EventLine[] {
  if (lines.length <= PENDING_PER_ROLE_MAX + 1) return lines;
  const rest = lines.slice(PENDING_PER_ROLE_MAX);
  return [
    ...lines.slice(0, PENDING_PER_ROLE_MAX),
    {
      streamId: rest[0]!.streamId,
      kind: "other",
      title: "other events",
      ref: null,
      count: rest.reduce((n, l) => n + l.count, 0),
    },
  ];
}

/**
 * When a flush may send: `due` (the flush job) only once the role's quiet
 * period is over, `now` (a person's Send now) at once.
 */
type FlushWhen = "due" | "now";

type PendingRow = typeof _supervisorEventPending.$inferSelect;

/** A message claimed from the gathered events, its row written as `sending`. */
interface Claimed {
  messageId: EventMessageId;
  text: string;
  pending: PendingRow[];
}

/**
 * Claim what `roleId` has gathered as one `sending` message, under the role's
 * lock: the gathered rows deleted, the message row written (so its quiet
 * period holds while it is delivered). Nothing gathered, or a live session
 * whose agent has not started yet: nothing claimed.
 */
async function claimMessage(
  roleId: string,
  when: FlushWhen,
): Promise<Claimed | "nothing" | "starting" | { notBefore: Date }> {
  return db.transaction(async (tx) => {
    await lockRoleEvents(roleId, tx);
    if (when === "due") {
      // A run enqueued before the last claim committed may run inside the
      // quiet period that claim started: it waits for its end instead.
      const at = await dueAt(roleId, tx);
      if (at.getTime() > Date.now()) return { notBefore: at };
    }
    const pending = await tx
      .select()
      .from(_supervisorEventPending)
      .where(eq(_supervisorEventPending.roleId, roleId))
      .orderBy(
        desc(_supervisorEventPending.count),
        desc(_supervisorEventPending.lastAt),
      );
    if (pending.length === 0) return "nothing";
    const session = await liveSessionOf(roleId, tx);
    if (
      session !== null &&
      (await sessionConversation(session.id, tx)) === null
    )
      return "starting";
    const lines = capLines(
      pending.map((r) => ({
        streamId: r.streamId,
        kind: r.kind,
        title: r.title,
        ref: r.ref,
        count: r.count,
      })),
    );
    const since = pending.reduce<Date | null>(
      (a, r) => (a === null || r.firstAt < a ? r.firstAt : a),
      null,
    );
    const messageId = eventMessageIdKind.mint();
    const text = renderEventMessage(lines, streamLabel, since, messageId);
    await tx.delete(_supervisorEventPending).where(
      inArray(
        _supervisorEventPending.id,
        pending.map((r) => r.id),
      ),
    );
    await tx.insert(_supervisorEventMessages).values({
      id: messageId,
      roleId,
      events: lines.reduce((n, l) => n + l.count, 0),
      lines,
      outcome: "sending",
      taskId: null,
    });
    return { messageId, text, pending };
  });
}

/**
 * A delivery threw: the message never happened. Its row goes, and its events
 * go back to the gathered ones (folded into any that landed meanwhile), so
 * the next flush sends them.
 */
async function unclaimMessage(roleId: string, claimed: Claimed): Promise<void> {
  const p = _supervisorEventPending;
  await db.transaction(async (tx) => {
    await lockRoleEvents(roleId, tx);
    await tx
      .delete(_supervisorEventMessages)
      .where(eq(_supervisorEventMessages.id, claimed.messageId));
    await tx
      .insert(p)
      .values(claimed.pending)
      .onConflictDoUpdate({
        target: [p.roleId, p.streamId, p.key],
        set: {
          count: sql`${p.count} + excluded.count`,
          firstAt: sql`least(${p.firstAt}, excluded.first_at)`,
        },
      });
  });
}

/**
 * Send what `roleId` has gathered as ONE message, now: typed into its live
 * session as an event turn, or — with no live session — dropped, filed as one
 * backlog task, or briefed into a session it launches (the role's `idle`).
 * Nothing gathered: nothing to do. A session whose agent has not started yet
 * keeps the events gathered and looks again shortly; with `when: "due"`, a
 * quiet period not over yet waits for its end.
 *
 * Three steps, so delivery runs outside any transaction (typing a turn and
 * launching a session open their own): claim the message under the role's
 * lock, deliver it, then record its outcome — or, if delivery throws, put
 * its events back and rethrow (the job retries).
 */
export async function flushRoleEvents(
  roleId: string,
  when: FlushWhen,
): Promise<void> {
  const claimed = await claimMessage(roleId, when);
  if (claimed === "nothing") return;
  if (typeof claimed === "object" && "notBefore" in claimed) {
    await supervisorEventsFlushJob.enqueue(
      { roleId },
      { runAt: claimed.notBefore },
    );
    return;
  }
  if (claimed === "starting") {
    await supervisorEventsFlushJob.enqueue(
      { roleId },
      { runAt: new Date(Date.now() + SESSION_STARTING_RETRY_MS) },
    );
    return;
  }
  let sent: { outcome: MessageOutcome; taskId: string | null };
  try {
    sent = await deliver(roleId, claimed.text);
  } catch (err) {
    await unclaimMessage(roleId, claimed);
    throw err;
  }
  await db.transaction(async (tx) => {
    await tx
      .update(_supervisorEventMessages)
      .set({ outcome: sent.outcome, taskId: sent.taskId })
      .where(eq(_supervisorEventMessages.id, claimed.messageId));
    await pruneMessages(roleId, tx);
  });
}

async function deliver(
  roleId: string,
  text: string,
): Promise<{ outcome: MessageOutcome; taskId: string | null }> {
  const session = await liveSessionOf(roleId);
  if (session !== null) {
    const conversationId = await sessionConversation(session.id, db);
    if (conversationId !== null) {
      const outcome = await submitTurn(conversationId, {
        kind: "event",
        text,
        typedText: text,
      });
      if (outcome.kind === "submitted")
        return { outcome: "sent", taskId: session.id };
    }
    // The session's agent is gone or done: as good as no live session.
  }
  const { idle } = await settingsOf(roleId, db);
  switch (idle) {
    case "drop":
      return { outcome: "dropped", taskId: null };
    case "backlog": {
      const head = text.split("\n", 1)[0] ?? "Events";
      const taskId = await fileSystemBacklogTask(
        { roleId, title: head, description: text, filedFrom: FILED_FROM },
        db,
      );
      return { outcome: "filed", taskId };
    }
    case "launch": {
      const role = await getSupervisorRole(roleId, db);
      if (!role) throw new Error(`No supervisor role "${roleId}".`);
      const opened = await openRoleSession(
        role,
        DEFAULT_MODEL_CHOICE,
        `## Events that launched this session\n\n${text}`,
      );
      return { outcome: "launched", taskId: opened.taskId };
    }
  }
}

async function pruneMessages(roleId: string, tx: DbExecutor): Promise<void> {
  const m = _supervisorEventMessages;
  const old = await tx
    .select({ id: m.id })
    .from(m)
    .where(eq(m.roleId, roleId))
    .orderBy(desc(m.sentAt), desc(m.id))
    .offset(MESSAGES_KEPT_PER_ROLE);
  if (old.length === 0) return;
  await tx.delete(m).where(
    inArray(
      m.id,
      old.map((r) => r.id),
    ),
  );
}

/**
 * A role's quiet period ended (or its session's agent may be up now): send
 * what it gathered. Keyed by role, so one waits per role however many events
 * land meanwhile.
 */
export const supervisorEventsFlushJob = defineJob({
  name: "supervisor-events.flush",
  description:
    "Sends a supervisor role what it gathered during its quiet period as one summarized message.",
  // Typing a turn, or launching a session, is seconds at most.
  hold: "seconds",
  input: z.object({ roleId: z.string() }),
  event: z.never(),
  dedup: { key: ({ roleId }) => roleId },
  run: async ({ input }) => {
    await flushRoleEvents(input.roleId, "due");
  },
});
