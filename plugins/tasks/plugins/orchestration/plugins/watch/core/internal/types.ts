import { z } from "zod";
import { defineIdKind, type IdOf } from "@plugins/ids/core";
import { defineCapability } from "@plugins/tasks/plugins/orchestration/plugins/mandate/plugins/policy/core";

/**
 * Who a watch wakes:
 * - `conversation` — an agent, woken by ONE `event` turn per batch;
 * - `code` — a `WatchHandler` contribution, called with the batch; `key` tells
 *   the handler which of its owners asked (e.g. an automation id).
 */
export const WatcherSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("conversation"), conversationId: z.string() }),
  z.object({
    kind: z.literal("code"),
    handler: z.string().min(1),
    key: z.string(),
  }),
]);
export type Watcher = z.infer<typeof WatcherSchema>;

/** What a watch source turns one fact into: an event about a task, routed to
 * the nearest live watch above it. `kind` is open — the source names it. */
export interface WatchEventInput {
  kind: string;
  taskId: string;
  /** The conversation whose action this is; its own watches never hear it. */
  actorConversationId?: string;
  /** One line a watcher reads (a report's whole body for `reported`). */
  summary: string;
  payload?: Record<string, unknown>;
}

/** One routed event, as a watcher receives it. */
export interface WatchEvent {
  id: string;
  kind: string;
  taskId: string;
  actorConversationId: string | null;
  summary: string;
  payload: Record<string, unknown>;
  createdAt: Date;
}

/** The event kind the watch plugin raises itself: the watched subtree went
 * quiet (no agent busy in it, nothing armed that can launch). */
export const QUIET_EVENT_KIND = "quiet";

/**
 * May watch the tasks it files: each task this agent files is watched by it,
 * and what happens in that task's subtree (agents starting, reports, flags,
 * the subtree going quiet) arrives as an event turn. `true` only — no grant,
 * no watching.
 */
export const watchChildren = defineCapability<true>({
  id: "watch.children",
  schema: z.literal(true),
  label: "Watch the tasks it files",
});

/** One watch (`task_watches.id`). */
export const watchIdKind = defineIdKind({
  prefix: "watch",
  label: "Watch",
  shape: "uuid",
});

/** One routed event (`watch_inbox.id`). */
export const watchEventIdKind = defineIdKind({
  prefix: "wevt",
  label: "Watch event",
  shape: "uuid",
});

export type WatchId = IdOf<typeof watchIdKind>;
