import { sql } from "drizzle-orm";
import { boolean, index, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { deriveUpdatedAt } from "@plugins/database/plugins/derived-updated-at/server";
import { parsedText } from "@plugins/database/plugins/sql-column/server";
import { idColumn } from "@plugins/ids/server";
import { _conversations } from "@plugins/tasks/plugins/tasks-core/server";
import { turnIdKind } from "../../core/id-kind";
import { TurnKindSchema, TurnStateSchema } from "../../core/schemas";

// One row per turn sent to an agent — every sender (the prompt input, a held
// turn's delivery, Push & Exit, a question's answer) goes through the ledger,
// so there is no turn the app typed without a row. `state` is the lifecycle in
// core/schemas.ts, moved only by `applyTurnEvent` (store.ts).
//
// `text` is what the user wrote, raw (attachment refs unresolved) — the draft
// a returned turn goes back to, and what `conversation.userTurnSent` carries.
// `typed_text` is exactly what reached the CLI: attachment refs resolved to
// `@<disk-path>`, or the whole launch prompt for a held turn that rode the
// launch. The hook's prompt is compared with it.
//
// `created_at` is `clock_timestamp()`, not `now()`: a held turn is inserted
// after the conversation row lock, so the wall clock at insert follows the lock
// order — the order the user's turns were accepted in, which is the order they
// are delivered in. `now()` is transaction START time.
export const _conversationTurns = deriveUpdatedAt(
  pgTable(
    "conversation_turns",
    {
      id: idColumn(turnIdKind),
      conversationId: text("conversation_id")
        .notNull()
        .references(() => _conversations.id, { onDelete: "cascade" }),
      kind: parsedText("kind", TurnKindSchema).notNull(),
      text: text("text").notNull(),
      typedText: text("typed_text").notNull(),
      state: parsedText("state", TurnStateSchema).notNull(),
      hookless: boolean("hookless").notNull().default(false),
      // `merged` only: the hook's whole prompt, and the part of it that was
      // not this turn.
      submittedText: text("submitted_text"),
      extraText: text("extra_text"),
      error: text("error"),
      createdAt: timestamp("created_at", { withTimezone: true })
        .default(sql`clock_timestamp()`)
        .notNull(),
      updatedAt: timestamp("updated_at", { withTimezone: true })
        .default(sql`clock_timestamp()`)
        .notNull(),
    },
    (t) => [
      // Every read is "this conversation's turns, by age": the web's window,
      // the held flush, the hook's candidates.
      index("conversation_turns_conversation_idx").on(
        t.conversationId,
        t.createdAt,
      ),
      // The retention sweep's age column.
      index("conversation_turns_updated_at_idx").on(t.updatedAt),
    ],
  ),
  {
    touchedBy: {
      typedText: true,
      state: true,
      hookless: true,
      submittedText: true,
      extraText: true,
      error: true,
      id: false,
      conversationId: false,
      kind: false,
      text: false,
      createdAt: false,
    },
  },
);

// The conversations whose CURRENT session was launched with the ledger's
// UserPromptSubmit hook — written by the runtime on every launch (a resume
// included, which is how a session from before the hook existed picks it up).
// A conversation without a row is `hookless`: nothing will ever confirm its
// turns, so `typed` is final for them.
export const _conversationPromptHooks = pgTable("conversation_prompt_hooks", {
  conversationId: text("conversation_id")
    .primaryKey()
    .references(() => _conversations.id, { onDelete: "cascade" }),
  launchedAt: timestamp("launched_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});
