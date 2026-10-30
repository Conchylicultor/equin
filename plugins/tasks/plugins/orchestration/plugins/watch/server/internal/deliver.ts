import { and, asc, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import type { DbExecutor } from "@plugins/database/server";
import {
  turnIdKind,
  type TurnId,
} from "@plugins/conversations/plugins/turn-ledger/core";
import { _tasks } from "@plugins/tasks/plugins/tasks-core/server";
import { sha256Hex } from "@plugins/packages/plugins/string-hash/core";
import type {
  HeldTurn,
  TurnReadiness,
} from "@plugins/conversations/plugins/automatic-turn/server";
import type { WatchEvent, WatchId } from "../../core";
import type { WatchHandlerEntry } from "./contributions";
import { getWatch, isWatchLive, nearestLiveWatch } from "./queries";
import { _watchInbox } from "./tables";

/** What delivery reads and does outside the inbox: ports, so a test drives the
 * policy over the real tables with a fake agent. */
export interface DeliverPorts {
  /** Whether an automatic turn may be typed into the watcher conversation
   * now (conversations/automatic-turn), read on the delivery's transaction. */
  readiness(conversationId: string, exec: DbExecutor): Promise<TurnReadiness>;
  /** Submit one `event` turn (idempotent on `turnId`). */
  submit(conversationId: string, turnId: TurnId, text: string): Promise<void>;
  /** The tree digest appended to the turn (advances the watcher's cursor). */
  digest(conversationId: string): Promise<string | null>;
  /** Whether the turn ledger has `turnId` — a claim whose turn it lacks was
   * never sent (the backend died between the claim and the send). */
  turnRecorded(turnId: TurnId, exec: DbExecutor): Promise<boolean>;
  handler(id: string): WatchHandlerEntry | undefined;
}

export type DeliverOutcome =
  | { kind: "not-found" }
  | { kind: "empty" }
  /** The watcher cannot take a turn now (busy, waiting on the user, or
   * another plugin's turn goes first); its next status change re-runs
   * delivery. */
  | HeldTurn
  /** The watch is dead: its rows moved to `to` (each needs a delivery). */
  | { kind: "rerouted"; to: WatchId[]; dropped: number }
  /** A code watcher's batch, handled on the claiming transaction. */
  | { kind: "delivered"; turnId: string; count: number }
  /** A conversation watcher's rows, claimed into one turn that is not sent
   * yet: `sendClaimedTurn` sends it once the claim committed. */
  | ClaimedTurn;

/** Rows claimed for a conversation watcher, waiting to be sent as one turn. */
export interface ClaimedTurn {
  kind: "claimed";
  watchId: WatchId;
  conversationId: string;
  turnId: TurnId;
  events: WatchEvent[];
  titles: ReadonlyMap<string, string>;
}

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

/** Rows claimed into a turn the ledger never recorded go back to
 * undelivered: the claim committed, the send never happened. */
async function reclaimUnsent(
  exec: DbExecutor,
  watchId: WatchId,
  ports: DeliverPorts,
): Promise<void> {
  const claimed = await exec
    .selectDistinct({ turnId: _watchInbox.deliveredInTurn })
    .from(_watchInbox)
    .where(
      and(
        eq(_watchInbox.watchId, watchId),
        isNotNull(_watchInbox.deliveredInTurn),
      ),
    );
  for (const { turnId } of claimed) {
    if (turnId === null) continue;
    if (await ports.turnRecorded(turnIdKind.parse(turnId), exec)) continue;
    await exec
      .update(_watchInbox)
      .set({ deliveredInTurn: null })
      .where(
        and(
          eq(_watchInbox.watchId, watchId),
          eq(_watchInbox.deliveredInTurn, turnId),
        ),
      );
  }
}

/**
 * Claim a watch's undelivered events — run on ONE transaction (`exec`).
 *
 * - A dead watch (ended, or its conversation `done`) hands its rows to the
 *   next live watch above each row's task; rows no live watch covers drop.
 * - A conversation watcher that cannot take an automatic turn now is held
 *   (`ports.readiness`): busy (the turn would be folded into the running
 *   one), waiting on the user (it would answer their question), or another
 *   plugin's turn is pending for it (it goes first — typed after ours it
 *   would reach a busy CLI).
 * - Otherwise every undelivered row is claimed into ONE turn (or ONE code
 *   batch), whose id is derived from the rows. A code batch is handled here,
 *   on the claim; a conversation turn is only claimed (`claimed`) — sending it
 *   is `sendClaimedTurn`, AFTER this transaction commits.
 *
 * Never send the turn on the claiming transaction: submitting a turn opens
 * transactions of its own (the turn ledger) and may resume the agent, so a
 * claim held across it pins a background transaction lease while waiting for
 * another. Three deliveries at once took every lease and each waited for a
 * fourth — wedging every background transaction in the backend (2026-10-30).
 */
export async function claimDelivery(
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
    const readiness = await ports.readiness(watcher.conversationId, exec);
    if (readiness.kind === "not-found")
      throw new Error(
        `watch ${watchId}: its conversation ${watcher.conversationId} does not exist`,
      );
    if (readiness.kind === "held") return readiness;
    await reclaimUnsent(exec, watchId, ports);
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
    return { kind: "delivered", turnId, count: rows.length };
  }
  const taskIds = [...new Set(events.map((e) => e.taskId))];
  const titleRows = await exec
    .select({ id: _tasks.id, title: _tasks.title })
    .from(_tasks)
    .where(inArray(_tasks.id, taskIds));
  return {
    kind: "claimed",
    watchId,
    conversationId: watcher.conversationId,
    turnId,
    events,
    titles: new Map(titleRows.map((t) => [t.id, t.title])),
  };
}

/**
 * Send a committed claim as one `event` turn, on no transaction. A failed
 * send gives the rows back (unclaims them) and rethrows, so the job's retry
 * claims the same rows into the same turn — `submit` no-ops on a turn id it
 * already recorded.
 */
export async function sendClaimedTurn(
  exec: DbExecutor,
  claim: ClaimedTurn,
  ports: DeliverPorts,
): Promise<{ kind: "delivered"; turnId: string; count: number }> {
  try {
    const digest = await ports.digest(claim.conversationId);
    await ports.submit(
      claim.conversationId,
      claim.turnId,
      renderEventTurn(claim.events, claim.titles, digest),
    );
  } catch (err) {
    await exec
      .update(_watchInbox)
      .set({ deliveredInTurn: null })
      .where(
        and(
          eq(_watchInbox.watchId, claim.watchId),
          eq(_watchInbox.deliveredInTurn, claim.turnId),
        ),
      );
    throw err;
  }
  return {
    kind: "delivered",
    turnId: claim.turnId,
    count: claim.events.length,
  };
}
