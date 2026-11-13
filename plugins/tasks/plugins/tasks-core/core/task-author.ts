import type { PluginId } from "@plugins/framework/plugins/plugin-id/core";

/**
 * Who decided a task should exist — stored as `tasks.author_kind` (+
 * `author_conversation_id` for an agent), shown as every task list's
 * "Created by" field.
 *
 * - `human`: a person's action filed it — typed in a composer, or a button
 *   whose whole effect is filing it (Investigate on a report, Launch on a saved
 *   agent).
 * - `agent`: an agent filed it (`add_task`, `file_task`, …) from its
 *   conversation.
 * - `system`: code filed it on its own (triage, automations). Which code is
 *   the task's `filedFrom`.
 *
 * Where it was filed from is a separate fact (`filedFrom`, a plugin id): a
 * person and an agent both file from many surfaces.
 */
export type TaskAuthor =
  | { kind: "human" }
  | { kind: "agent"; conversationId: string }
  | { kind: "system" };

export type TaskAuthorKind = TaskAuthor["kind"];

export const TASK_AUTHOR_KINDS = ["human", "agent", "system"] as const;

/** How each author kind is named: the "Created by" field's options. */
export const TASK_AUTHOR_KIND_OPTIONS = {
  human: { label: "Human" },
  agent: { label: "Agent" },
  system: { label: "System" },
} as const;

/** Every task filing names who decided it and the surface it came from. */
export interface TaskFiling {
  author: TaskAuthor;
  filedFrom: PluginId;
}

/** The stored columns of an author (the inverse of {@link taskAuthorOf}). */
export function taskAuthorColumns(author: TaskAuthor): {
  authorKind: TaskAuthorKind;
  authorConversationId: string | null;
} {
  return {
    authorKind: author.kind,
    authorConversationId:
      author.kind === "agent" ? author.conversationId : null,
  };
}

/**
 * A task row's author, read back from its columns. The DB CHECK
 * `tasks_author_agent_has_conversation` ties the two, so a mismatch here is a
 * broken invariant and throws.
 */
export function taskAuthorOf(row: {
  authorKind: TaskAuthorKind;
  authorConversationId: string | null;
}): TaskAuthor {
  if (row.authorKind === "agent") {
    if (row.authorConversationId === null) {
      throw new Error("task author: an agent author has no conversation id");
    }
    return { kind: "agent", conversationId: row.authorConversationId };
  }
  return { kind: row.authorKind };
}
