import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import type { DbExecutor } from "@plugins/database/server";
import {
  turnIdKind,
  type TurnId,
} from "@plugins/conversations/plugins/turn-ledger/core";
import { _tasks } from "@plugins/tasks/plugins/tasks-core/server";
import { sha256Hex } from "@plugins/packages/plugins/string-hash/core";
import type { WatchEvent, WatchId } from "../../core";
import type { WatchHandlerEntry } from "./contributions";
import { getWatch, isWatchLive, nearestLiveWatch } from "./queries";
import { _watchInbox } from "./tables";

/** What delivery reads and does outside the inbox: ports, so a test drives the
 * policy over the real tables with a fake agent. */
export interface DeliverPorts {
  /** The watcher conversation's state; null when it does not exist. */
  conversation(
    id: string,
  ): Promise<{ busy: boolean; waitingFor: string | null } | null>;
  /** Submit one `event` turn (idempotent on `turnId`). */
  submit(conversationId: string, turnId: TurnId, text: string): Promise<void>;
  /** The tree digest appended to the turn (advances the watcher's cursor). */
  digest(conversationId: string): Promise<string | null>;
  handler(id: string): WatchHandlerEntry | undefined;
}

export type DeliverOutcome =
  | { kind: "not-found" }
  | { kind: "empty" }
  /** The watcher cannot take a turn now; a status change re-runs delivery. */
  | { kind: "held"; reason: "busy" | "waiting-for" }
  /** The watch is dead: its rows moved to `to` (each needs a delivery). */
  | { kind: "rerouted"; to: WatchId[]; dropped: number }
  | { kind: "delivered"; turnId: string; count: number };

/** The turn a batch is: a uuid-shaped digest of its row ids, so delivering
 * the same rows again is the same turn (submitTurn no-ops on it). */
export function turnIdFor(rowIds: readonly string[]): TurnId {
  const hex = sha256Hex([...rowIds].sort().join(","));
  return turnIdKind.parse(
    `turn-${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`,
  );
}

type InboxRow = typeof _watchInbox.$inferSelect;

function toEvent(r: InboxRow): WatchEvent {
  return {
    id: r.id,
    kind: r.kind,
    taskId: r.taskId,
    actorConversationId: r.actorConversationId,
    summary: r.summary,
    payload: r.payload,
    createdAt: r.createdAt,
  };
}

/** One event turn: a line per event (kind · task · title — summary, a
 * multi-line summary indented under it), then the digest. */
export function renderEventTurn(
  events: readonly WatchEvent[],
  titles: ReadonlyMap<string, string>,
  digest: string | null,
): string {
  const lines = events.map((e) => {
    const [first = "", ...rest] = e.summary.split("\n");
    const title = titles.get(e.taskId);
    const head = `- ${e.kind} · ${e.taskId}${title === undefined ? "" : ` ${JSON.stringify(title)}`} — ${first}`;
    return rest.length === 0
      ? head
      : [head, ...rest.map((l) => (l === "" ? "" : `    ${l}`))].join("\n");
  });
  const header =
    events.length === 1
      ? "An event in the tasks you watch:"
      : `${events.length} events in the tasks you watch:`;
  return [header, ...lines, ...(digest ? ["", digest] : [])].join("\n");
}

async function undelivered(
  exec: DbExecutor,
  watchId: WatchId,
): Promise<InboxRow[]> {
  return exec
    .select()
    .from(_watchInbox)
    .where(
      and(
        eq(_watchInbox.watchId, watchId),
        isNull(_watchInbox.deliveredInTurn),
      ),
    )
    .orderBy(asc(_watchInbox.createdAt), asc(_watchInbox.id))
    .for("update");
}

/**
 * Deliver a watch's undelivered events — run on ONE transaction (`exec`).
 *
 * - A dead watch (ended, or its conversation `done`) hands its rows to the
 *   next live watch above each row's task; rows no live watch covers drop.
 * - A conversation watcher that is busy or waiting on the user is held: an
 *   event turn would interrupt it, or answer its pending question.
 * - Otherwise every undelivered row is claimed into ONE turn (or ONE code
 *   batch), whose id is derived from the rows.
 */
export async function deliverOn(
  exec: DbExecutor,
  watchId: WatchId,
  ports: DeliverPorts,
): Promise<DeliverOutcome> {
  const watch = await getWatch(exec, watchId);
  if (watch === null) return { kind: "not-found" };

  if (!(await isWatchLive(exec, watchId))) {
    const rows = await undelivered(exec, watchId);
    const to = new Set<WatchId>();
    let dropped = 0;
    for (const row of rows) {
      const target = await nearestLiveWatch(
        exec,
        row.taskId,
        row.actorConversationId,
      );
      if (target === null) {
        await exec.delete(_watchInbox).where(eq(_watchInbox.id, row.id));
        dropped++;
        continue;
      }
      await exec
        .update(_watchInbox)
        .set({ watchId: target.id })
        .where(eq(_watchInbox.id, row.id));
      to.add(target.id);
    }
    return { kind: "rerouted", to: [...to], dropped };
  }

  const { watcher } = watch;
  if (watcher.kind === "conversation") {
    const state = await ports.conversation(watcher.conversationId);
    if (state === null)
      throw new Error(
        `watch ${watchId}: its conversation ${watcher.conversationId} does not exist`,
      );
    if (state.busy) return { kind: "held", reason: "busy" };
    if (state.waitingFor !== null)
      return { kind: "held", reason: "waiting-for" };
  }

  const rows = await undelivered(exec, watchId);
  if (rows.length === 0) return { kind: "empty" };
  const ids = rows.map((r) => r.id);
  const turnId = turnIdFor(ids);
  await exec
    .update(_watchInbox)
    .set({ deliveredInTurn: turnId })
    .where(inArray(_watchInbox.id, ids));
  const events = rows.map(toEvent);

  if (watcher.kind === "code") {
    const handler = ports.handler(watcher.handler);
    if (handler === undefined)
      throw new Error(
        `watch ${watchId}: no WatchHandler "${watcher.handler}" is contributed`,
      );
    await handler.onEvents(events, { watch, tx: exec });
  } else {
    const taskIds = [...new Set(events.map((e) => e.taskId))];
    const titleRows = await exec
      .select({ id: _tasks.id, title: _tasks.title })
      .from(_tasks)
      .where(inArray(_tasks.id, taskIds));
    const titles = new Map(titleRows.map((t) => [t.id, t.title]));
    const digest = await ports.digest(watcher.conversationId);
    await ports.submit(
      watcher.conversationId,
      turnId,
      renderEventTurn(events, titles, digest),
    );
  }
  return { kind: "delivered", turnId, count: rows.length };
}
