/**
 * The conversation lists' fields, derived from the `conversations` entity and
 * the owners' joined columns: the ids every list (and every saved view, every
 * filter preset) names are unchanged, the sortable ones are exactly
 * `CONVERSATION_SORTABLE`, and the search columns are filterable text.
 *
 * Run: `./singularity test plugins/conversations/plugins/all-conversations`.
 */

import { describe, expect, test } from "bun:test";
import { CONVERSATION_SEARCHABLE, CONVERSATION_SORTABLE } from "./fields";
import { allConversations, conversationHistory } from "./collection";

/** The ids the lists named before their fields were derived — saved views name them. */
const LIST_FIELD_IDS = [
  "title",
  "status",
  "model",
  "kind",
  "runtime",
  "createdAt",
  "updatedAt",
  "endedAt",
  "worktreePath",
  "taskTitle",
];

describe("conversation list fields", () => {
  test("both collections derive the same field ids, in the same order", () => {
    for (const c of [allConversations, conversationHistory]) {
      expect(Object.keys(c.fields)).toEqual(LIST_FIELD_IDS);
      expect(Object.keys(c.filterable)).toEqual(LIST_FIELD_IDS);
      expect([...c.sortable]).toEqual([...CONVERSATION_SORTABLE]);
    }
    expect(allConversations.columnScope).toBe("all-conversations");
    expect(conversationHistory.columnScope).toBe("conversations-sidebar");
  });

  test("labels, the title field and the enum options come from the entity", () => {
    const f = allConversations.fields;
    expect(f.title).toMatchObject({
      label: "Title",
      primary: true,
      sortable: true,
    });
    expect(f.status.options).toMatchObject({ working: { label: "Working" } });
    expect(f.kind.options).toMatchObject({ system: { label: "System" } });
    expect(f.taskTitle).toMatchObject({ label: "Task", domain: "text" });
    expect(f.createdAt.domain).toBe("instant");
  });

  test("every search column is filterable text", () => {
    for (const c of CONVERSATION_SEARCHABLE) {
      expect(allConversations.filterable[c].domain).toBe("text");
    }
  });

  test("the row carries the id and the owners' keys, and reaches the conversation and its task", () => {
    expect([...allConversations.rowKeys] as string[]).toEqual([
      ...LIST_FIELD_IDS,
      "id",
      "spawnedBy",
      "taskId",
    ]);
    expect(Object.keys(allConversations.exposes ?? {})).toEqual([
      "base",
      "task",
    ]);
  });
});
