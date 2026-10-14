/**
 * The exposed category keeps the id saved task-list views name (`category`)
 * and reads NULL — the None bucket — for a task with no row.
 *
 * Run: `./singularity test plugins/tasks/plugins/task-category`.
 */

import { expect, test } from "bun:test";
import { tasksEntityRef } from "@plugins/tasks/plugins/tasks-core/core";
import { taskCategoryShape } from "./resources";

test("the category is exposed on tasks as `category`, NULL when absent", () => {
  const exposure = taskCategoryShape.exposure;
  expect(exposure.parent).toBe(tasksEntityRef);
  expect(Object.values(exposure.fields).map((f) => f.id)).toEqual(["category"]);
  expect(exposure.fields.category).toMatchObject({
    label: "Category",
    absent: null,
    options: null,
  });
});
