import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { z } from "zod";
import { parsedJson } from "@plugins/database/plugins/sql-column/server";
import {
  _conversations,
  _tasks,
} from "@plugins/tasks/plugins/tasks-core/server";
import { idColumn, idRef } from "@plugins/ids/server";
import { watchEventIdKind, watchIdKind, WatcherSchema } from "../../core";

/**
 * Who watches which task's subtree. A watch is LIVE while `ended_at` is null
 * and — for a conversation watcher — its conversation is not `done`; an event
 * in the subtree goes to the nearest live watch up the folder chain.
 *
 * - `watcher` — the discriminated watcher; `watcher_key` its one-string form,
 *   so a second `watchTask` for the same (task, watcher) finds the first.
 * - `watcher_conversation_id` — the conversation watcher's id, denormalized for
 *   the liveness join and the cascade (a deleted conversation takes its
 *   watches with it); null for a code watcher.
 * - `quiet` — whether the subtree was quiet at the last evaluation; only a
 *   false → true flip raises a `quiet` event.
 */
export const _taskWatches = pgTable(
  "task_watches",
  {
    id: idColumn(watchIdKind, { sqlDefault: true }),
    taskId: text("task_id")
      .notNull()
      .references(() => _tasks.id, { onDelete: "cascade" }),
    watcher: parsedJson("watcher", WatcherSchema).notNull(),
    watcherKey: text("watcher_key").notNull(),
    watcherConversationId: text("watcher_conversation_id").references(
      () => _conversations.id,
      { onDelete: "cascade" },
    ),
    quiet: boolean("quiet").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("task_watches_live_uq")
      .on(t.taskId, t.watcherKey)
      .where(sql`${t.endedAt} IS NULL`),
    index("task_watches_task_idx").on(t.taskId),
    index("task_watches_conversation_idx").on(t.watcherConversationId),
  ],
);

/**
 * Events routed to a watch and not yet delivered. `delivered_in_turn` is set
 * when a delivery claims the row: the id of the ONE turn (or code batch) that
 * carried it — derived from the claimed rows, so a retried delivery of the
 * same batch is the same turn.
 */
export const _watchInbox = pgTable(
  "watch_inbox",
  {
    id: idColumn(watchEventIdKind, { sqlDefault: true }),
    watchId: idRef(watchIdKind, "watch_id", () => _taskWatches.id, {
      onDelete: "cascade",
    }).notNull(),
    kind: text("kind").notNull(),
    taskId: text("task_id").notNull(),
    actorConversationId: text("actor_conversation_id"),
    summary: text("summary").notNull(),
    payload: parsedJson("payload", z.record(z.string(), z.unknown()))
      .notNull()
      .default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    deliveredInTurn: text("delivered_in_turn"),
  },
  (t) => [
    index("watch_inbox_undelivered_idx")
      .on(t.watchId)
      .where(sql`${t.deliveredInTurn} IS NULL`),
  ],
);
