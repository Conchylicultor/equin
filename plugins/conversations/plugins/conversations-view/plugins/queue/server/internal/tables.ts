import { defineExtension } from "@plugins/infra/plugins/entity-extensions/server";
import { _conversations } from "@plugins/tasks/plugins/tasks-core/server";
import { queueShape } from "../../core";

// The queue row of a conversation: its position (`rank`) and whether the user
// pinned it. The pin sits on the SAME row as the rank — it is a plain per-row
// flag the user sets, not derived state that has to be recomputed as
// conversations change status, so it needs neither a singleton table nor a
// resource of its own. The row is declared once, as `queueShape` in
// `core/resources.ts`.
export const conversationsQueue = defineExtension(
  _conversations,
  "queue",
  queueShape,
  {
    columns: { pinned: { default: false } },
  },
);
// Re-export the underlying pgTable so drizzle-kit's schema glob picks it up.
export const _conversationsQueueTable = conversationsQueue.table;
