import { defineIdKind, type IdOf } from "@plugins/ids/core";

/**
 * The three id kinds `tasks-core`'s tables are keyed by — `tasks.id`,
 * `attempts.id` and `conversations.id` — declared once with `defineIdKind`, so
 * the mint, the branded type, validation and inline recognition (the
 * active-data chips, the worktree name parsers) all read one
 * declaration rather than each re-typing the shape.
 *
 * All three are `stamped` (`<prefix>-<epochSeconds>-<6 base36>`). Live rows
 * carry the older shapes — a task stamped epoch MILLISECONDS with a ≤6-char
 * suffix, an attempt/conversation epoch seconds with a ≤4-char one — and are
 * still recognised: recognition is the generic body every kind shares, not the
 * current mint's exact shape.
 *
 * `claude` is the pre-rename prefix of attempts and conversations (one value
 * named both an attempt and its conversation, and the oldest are suffix-less
 * `claude-<epoch>`), so it is a recognition-only alias of both. Never minted.
 */
export const taskIdKind = defineIdKind({ prefix: "task", label: "Task" });

export const attemptIdKind = defineIdKind({
  prefix: "att",
  label: "Attempt",
  aliases: ["claude"],
});

export const conversationIdKind = defineIdKind({
  prefix: "conv",
  label: "Conversation",
  aliases: ["claude"],
});

export type TaskId = IdOf<typeof taskIdKind>;
export type AttemptId = IdOf<typeof attemptIdKind>;
export type ConversationId = IdOf<typeof conversationIdKind>;
