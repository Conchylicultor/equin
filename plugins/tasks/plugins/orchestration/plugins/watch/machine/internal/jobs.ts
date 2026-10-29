import { z } from "zod";
import { and, eq, exists, isNull } from "drizzle-orm";
import { db, type DbExecutor } from "@plugins/database/server";
import { defineJob } from "@plugins/infra/plugins/jobs/server";
import { isMain } from "@plugins/infra/plugins/runtime-identity/core";
import {
  ConversationStatusSchema,
  TaskStatusSchema,
} from "@plugins/tasks/plugins/tasks-core/core";
import { isAgentBusy } from "@plugins/conversations/core";
import { submitTurn } from "@plugins/conversations/server";
import { automaticTurnReadiness } from "@plugins/conversations/plugins/automatic-turn/server";
import { treeDigest } from "@plugins/tasks/plugins/orchestration/plugins/tree-digest/server";
import {
  grantOf,
  mandateOf,
} from "@plugins/tasks/plugins/orchestration/plugins/mandate/server";
import { watchTree } from "@plugins/tasks/plugins/orchestration/plugins/watch/plugins/capabilities/core";
import { watchIdKind } from "../../core";
import {
  watchHandlerById,
  watchSourceById,
} from "../../server/internal/contributions";
import { deliverOn, type DeliverPorts } from "../../server/internal/deliver";
import {
  enqueueOn,
  liveWatchesOnChain,
  takeOverTreeWatch,
} from "../../server/internal/queries";
import { evaluateQuiet } from "../../server/internal/quiet";
import { routeEvents } from "../../server/internal/route";
import { _taskWatches, _watchInbox } from "../../server/internal/tables";

// Every job here is main-only: a forked worktree DB inherits main's trigger
// rows and watches, so without the guard each worktree's worker would deliver
// the same events to the same agents (see `maybeLaunchTaskJob`).

const productionPorts: DeliverPorts = {
  // The watch is no PendingTurn contributor: every pending turn holds it.
  readiness: (conversationId, exec) =>
    automaticTurnReadiness(conversationId, { exec }),
  async submit(conversationId, turnId, text) {
    const out = await submitTurn(conversationId, {
      id: turnId,
      kind: "event",
      text,
      typedText: text,
    });
    if (out.kind === "not-found")
      throw new Error(`event turn: conversation ${conversationId} not found`);
  },
  async digest(conversationId) {
    return (await treeDigest({ conversationId }))?.text ?? null;
  },
  handler: watchHandlerById,
};

export const watchDeliverJob = defineJob({
  name: "watch.deliver",
  description:
    "Delivers the events routed to one watch as a single turn to the watching agent (or one batch to a code watcher), holding them while the agent is busy, waiting on the user, or has another automatic turn (a compaction) pending.",
  // instant: indexed reads and writes on one transaction; the turn is typed
  // to an agent that is idle by construction (busy ⇒ held).
  hold: "instant",
  input: z.object({ watchId: watchIdKind.schema }),
  event: z.never(),
  dedup: { key: ({ watchId }) => watchId },
  run: async ({ input: { watchId } }) => {
    if (!isMain()) return;
    await db.transaction(async (tx) => {
      const out = await deliverOn(tx, watchId, productionPorts);
      if (out.kind === "rerouted") {
        for (const to of out.to)
          await watchDeliverJob.enqueue({ watchId: to }, enqueueOn(tx));
      }
    });
  },
});

export const watchQuietJob = defineJob({
  name: "watch.quiet",
  description:
    "Re-checks whether a watched task subtree went quiet (no agent busy, nothing armed that can launch) and tells its watcher once when it does.",
  hold: "instant",
  input: z.object({ watchId: watchIdKind.schema }),
  event: z.never(),
  dedup: { key: ({ watchId }) => watchId },
  run: async ({ input: { watchId } }) => {
    if (!isMain()) return;
    await db.transaction(async (tx) => {
      if ((await evaluateQuiet(tx, watchId)) === "became-quiet")
        await watchDeliverJob.enqueue({ watchId }, enqueueOn(tx));
    });
  },
});

/** Re-evaluate quiet for every live watch on `taskId`'s chain. */
async function enqueueQuietForChain(
  exec: DbExecutor,
  taskId: string,
): Promise<void> {
  for (const w of await liveWatchesOnChain(exec, taskId))
    await watchQuietJob.enqueue({ watchId: w.id }, enqueueOn(exec));
}

export const watchIngestJob = defineJob({
  name: "watch.ingest",
  description:
    "Turns a fact in a task subtree (an agent started, a report, a flag, a task settled) into events for the nearest agent or automation watching that subtree.",
  hold: "instant",
  input: z.object({ source: z.string() }),
  // Any source's payload: the source's own `toEvents` reads it.
  event: z.object({}).passthrough(),
  dedup: "none",
  run: async ({ input, event }) => {
    if (!event) return;
    if (!isMain()) return;
    const source = watchSourceById(input.source);
    if (source === undefined)
      throw new Error(`watch.ingest: no WatchSource "${input.source}"`);
    const events = await source.toEvents(event);
    if (events.length === 0) return;
    await db.transaction(async (tx) => {
      for (const watchId of await routeEvents(tx, events))
        await watchDeliverJob.enqueue({ watchId }, enqueueOn(tx));
      for (const taskId of new Set(events.map((e) => e.taskId)))
        await enqueueQuietForChain(tx, taskId);
    });
  },
});

export const watchOnTaskStatusJob = defineJob({
  name: "watch.on-task-status",
  description:
    "When a task's status changes, re-checks whether the watched subtrees above it went quiet.",
  hold: "instant",
  input: z.object({}),
  dedup: "none",
  event: z
    .object({ taskId: z.string(), status: TaskStatusSchema })
    .passthrough(),
  run: async ({ event }) => {
    if (!event) return;
    if (!isMain()) return;
    await enqueueQuietForChain(db, event.taskId);
  },
});

export const watchOnConversationStatusJob = defineJob({
  name: "watch.on-conversation-status",
  description:
    "When an agent starts or stops being busy, or stops waiting on the user, re-checks the watched subtrees above its task and delivers the events its own watches held meanwhile.",
  hold: "instant",
  input: z.object({}),
  dedup: "none",
  event: z
    .object({
      conversationId: z.string(),
      taskId: z.string().nullable(),
      status: ConversationStatusSchema,
      previousStatus: ConversationStatusSchema,
    })
    .passthrough(),
  run: async ({ event }) => {
    if (!event) return;
    if (!isMain()) return;
    const busyChanged =
      isAgentBusy(event.status) !== isAgentBusy(event.previousStatus);
    if (busyChanged && event.taskId !== null)
      await enqueueQuietForChain(db, event.taskId);
    // Its own open watches holding undelivered events: deliver now (or
    // re-route, when it just ended). Every change that can end a hold lands
    // here: leaving a busy status, `waitingFor` clearing (the event fires on
    // it too, the status unchanged), and the end of another plugin's pending
    // turn (that turn makes the agent busy, then idle again). Still unable to
    // take a turn ⇒ delivery holds anyway.
    if (isAgentBusy(event.status)) return;
    const holding = await db
      .select({ id: _taskWatches.id })
      .from(_taskWatches)
      .where(
        and(
          eq(_taskWatches.watcherConversationId, event.conversationId),
          isNull(_taskWatches.endedAt),
          exists(
            db
              .select({ id: _watchInbox.id })
              .from(_watchInbox)
              .where(
                and(
                  eq(_watchInbox.watchId, _taskWatches.id),
                  isNull(_watchInbox.deliveredInTurn),
                ),
              ),
          ),
        ),
      );
    for (const w of holding) await watchDeliverJob.enqueue({ watchId: w.id });
  },
});

export const watchOnConversationCreatedJob = defineJob({
  name: "watch.on-conversation-created",
  description:
    "When an agent starts on the root task of a mandate granting watch.tree, makes it the one watching the whole tree (taking the watch over from an earlier conversation there).",
  hold: "instant",
  input: z.object({}),
  dedup: "none",
  event: z
    .object({ conversationId: z.string(), taskId: z.string() })
    .passthrough(),
  // Not main-only: it writes the watch row and delivers nothing, and
  // `takeOverTreeWatch` is idempotent, so a forked DB replaying it is harmless.
  run: async ({ event }) => {
    if (!event) return;
    const mandate = await mandateOf(event.taskId);
    if (mandate.kind !== "found" || mandate.rootTaskId !== event.taskId) return;
    if ((await grantOf(watchTree, event.conversationId)) === null) return;
    await takeOverTreeWatch(event.taskId, event.conversationId);
  },
});
