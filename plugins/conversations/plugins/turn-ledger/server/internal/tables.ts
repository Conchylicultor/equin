import { sql } from "drizzle-orm";
import { index } from "drizzle-orm/pg-core";
import { nullable } from "@plugins/fields/core";
import { textField } from "@plugins/fields/plugins/text/plugins/config/core";
import { dateField } from "@plugins/fields/plugins/date/plugins/config/core";
import {
  defineEntity,
  sqlDefault,
} from "@plugins/infra/plugins/entities/server";
import { _conversations } from "@plugins/tasks/plugins/tasks-core/server";
import { ledgerTurnsEntityRef } from "../../core/entity";

// One row per turn sent to an agent — every sender (the prompt input, a held
// turn's delivery, Push & Exit, a question's answer) goes through the ledger,
// so there is no turn the app typed without a row. `state` is the lifecycle in
// core/schemas.ts, moved only by `applyTurnEvent` (store.ts).
//
// `text` is what the user wrote, raw (attachment refs unresolved) — the draft
// a returned turn goes back to, and what `conversation.userTurnSent` carries.
// `typed_text` is exactly what reached the CLI: attachment refs resolved to
// `@<disk-path>`, or the whole launch prompt for a held turn that rode the
// launch. The confirmed prompt is compared with it.
//
// `created_at` is `clock_timestamp()`, not `now()`: a held turn is inserted
// after the conversation row lock, so the wall clock at insert follows the lock
// order — the order the user's turns were accepted in, which is the order they
// are delivered in. `now()` is transaction START time.
export const conversationTurnsEntity = defineEntity(
  ledgerTurnsEntityRef,
  {
    typedText: textField(),
    // `merged` only: the confirmed whole prompt, and the part of it that was
    // not this turn (`extraText`).
    submittedText: nullable(textField()),
    // `accepted` / `merged`: when the agent took it — its `turn_started`
    // event's own time, so a late replay still records the agent's moment. The
    // status reconciler weighs it against the agent's own idle/busy write.
    submittedAt: nullable(dateField()),
  },
  {
    primaryKey: "id",
    columns: {
      conversationId: {
        references: { column: () => _conversations.id, onDelete: "cascade" },
      },
      createdAt: { default: sqlDefault(sql`clock_timestamp()`) },
      updatedAt: { default: sqlDefault(sql`clock_timestamp()`) },
    },
    indexes: (t) => [
      // Every read is "this conversation's turns, by age": the web's window,
      // the held flush, the confirmation's candidates.
      index("conversation_turns_conversation_idx").on(
        t.conversationId,
        t.createdAt,
      ),
      // The retention sweep's age column.
      index("conversation_turns_updated_at_idx").on(t.updatedAt),
    ],
    updatedAt: {
      touchedBy: {
        typedText: true,
        state: true,
        submittedText: true,
        submittedAt: true,
        extraText: true,
        error: true,
        id: false,
        conversationId: false,
        kind: false,
        text: false,
        createdAt: false,
      },
    },
  },
);

export const _conversationTurns = conversationTurnsEntity.table;
