import { defineExtension } from "@plugins/infra/plugins/entity-extensions/server";
import {
  defineEntity,
  defaultNow,
} from "@plugins/infra/plugins/entities/server";
import { _conversations } from "@plugins/tasks/plugins/tasks-core/server";
import { queueSectionsEntityRef, queueShape } from "../../core";

// The queue row of a conversation: its position (`rank`) and the section the
// user filed it into (`section`: `PINNED_SECTION`, a `csec-…` id, or null = the
// Queue). The section sits on the SAME row as the rank — it is plain per-row
// state the user sets, not derived state that has to be recomputed as
// conversations change status, so it needs neither a singleton table nor a
// resource of its own. The row is declared once, as `queueShape` in
// `core/resources.ts`.
export const conversationsQueue = defineExtension(
  _conversations,
  "queue",
  queueShape,
);
// Re-export the underlying pgTable so drizzle-kit's schema glob picks it up.
export const _conversationsQueueTable = conversationsQueue.table;

// The user's own sidebar sections, ranked among themselves (one flat rank
// space). Members point at a section by id from `conversations_ext_queue.section`
// — no foreign key, since the same column also holds the reserved
// `PINNED_SECTION`; every write path checks the id exists, and deleting a
// section returns its members to the Queue in the same transaction.
export const queueSectionsEntity = defineEntity(queueSectionsEntityRef, {
  primaryKey: "id",
  columns: {
    createdAt: { default: defaultNow() },
  },
});
export const _conversationSections = queueSectionsEntity.table;
