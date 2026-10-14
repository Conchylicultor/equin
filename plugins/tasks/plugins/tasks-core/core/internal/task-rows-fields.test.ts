/**
 * The task list's fields, derived from the `tasks` entity (`taskRows` is
 * declared by fields): the ids every task list — and every saved view, filter
 * preset and group-by — names are unchanged, and the wire row is still
 * exactly `TaskListItem`'s keys (the C39 old-bundle contract: additive
 * `$columns` aside, nothing removed or renamed).
 *
 * Run: `./singularity test plugins/tasks/plugins/tasks-core`.
 */

import { describe, expect, test } from "bun:test";
import { taskRows } from "../resources";
import { tasksEntityRef } from "../entity-refs";
import { TaskListItemSchema, TASK_STATUS_OPTIONS } from "./schema";

describe("taskRows fields", () => {
  test("the listed field ids are the task list's", () => {
    expect(Object.keys(taskRows.fields)).toEqual([
      "title",
      "updatedAt",
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
