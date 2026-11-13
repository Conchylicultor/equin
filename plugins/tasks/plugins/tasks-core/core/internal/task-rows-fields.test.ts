/**
 * The task list's fields, derived from the `tasks` entity (`taskRows` is
 * declared by fields): the ids every task list — and every saved view, filter
 * preset and group-by — names are pinned here, and the wire row is exactly
 * `TaskListItem`'s keys (a removed or renamed field renames the collection
 * keys, C39: `author` → `authorKind` / `authorConversationId` / `filedFrom`
 * moved `tasks.v2` → `tasks.v3`).
 *
 * Run: `./equin test plugins/tasks/plugins/tasks-core`.
 */

import { describe, expect, test } from "bun:test";
import { taskRows, taskWindow } from "../resources";
import { tasksEntityRef } from "../entity-refs";
import { TaskListItemSchema, TASK_STATUS_OPTIONS } from "./schema";
import { TASK_AUTHOR_KIND_OPTIONS } from "../task-author";

describe("taskRows fields", () => {
  test("the listed field ids are the task list's", () => {
    expect(Object.keys(taskRows.fields)).toEqual([
      "title",
      "updatedAt",
      "authorKind",
      "authorConversationId",
      "filedFrom",
      "status",
    ]);
    expect(taskRows.fields.title).toMatchObject({
      label: "Title",
      primary: true,
    });
    expect(taskRows.fields.updatedAt).toMatchObject({
      label: "Updated",
      domain: "instant",
    });
    expect(taskRows.fields.status).toMatchObject({
      label: "Status",
      options: TASK_STATUS_OPTIONS,
    });
    // Who filed the task and from where (`../task-author.ts`).
    expect(taskRows.fields.authorKind).toMatchObject({
      label: "Created by",
      options: TASK_AUTHOR_KIND_OPTIONS,
    });
    expect(taskRows.fields.authorConversationId).toMatchObject({
      label: "Author",
    });
    expect(taskRows.fields.filedFrom).toMatchObject({ label: "Filed from" });
  });

  test("the row is exactly TaskListItem's keys", () => {
    expect(([...taskRows.rowKeys] as string[]).sort()).toEqual(
      Object.keys(TaskListItemSchema.shape).sort(),
    );
  });

  test("the rows are the tasks entity's, folding its exposures", () => {
    expect(taskRows.from).toBe(tasksEntityRef);
    expect(taskRows.exposes).toEqual({ base: tasksEntityRef });
  });
});

describe("taskWindow — the tasks tree", () => {
  test("lists the task list's fields, plus the folder its tree reads", () => {
    // The saved views' ids are `taskRows`' (the task list moved from one to
    // the other); `folderId` is listed only because a tree's parent is a
    // filterable column (task-list hides it from every picker).
    expect(Object.keys(taskWindow.fields)).toEqual([
      "title",
      "updatedAt",
      "authorKind",
      "authorConversationId",
      "filedFrom",
      "folderId",
      "status",
    ]);
    expect(taskWindow.tree).toEqual({ parent: "folderId", rank: "rank" });
  });

  test("its row is `taskRows`' row — the same keys, `$childCount` beside them", () => {
    expect([...taskWindow.rowKeys].sort()).toEqual(
      [...taskRows.rowKeys].sort(),
    );
    expect(taskWindow.row.shape).toHaveProperty("$childCount");
  });
});
