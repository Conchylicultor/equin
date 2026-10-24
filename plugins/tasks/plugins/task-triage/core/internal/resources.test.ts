/**
 * The triage fields exposed on tasks: their ids (what saved views name), what
 * a task with no row reads (NULL — "Not triaged"), and each value's options.
 *
 * Run: `./equin test plugins/tasks/plugins/task-triage`.
 */

import { expect, test } from "bun:test";
import { tasksEntityRef } from "@plugins/tasks/plugins/tasks-core/core";
import { taskTriageShape } from "./resources";

test("triage is exposed on tasks, NULL when absent", () => {
  const exposure = taskTriageShape.exposure;
  expect(exposure.parent).toBe(tasksEntityRef);
  expect(exposure.slice).toBe("tasks_ext_triage");
  expect(Object.values(exposure.fields).map((f) => f.id)).toEqual([
    "triage",
    "priority",
    "taskType",
    "triagedAt",
  ]);
  for (const field of Object.values(exposure.fields)) {
    expect(field.absent).toBeNull();
  }
  expect(exposure.fields.state.label).toBe("Triage");
  expect(exposure.fields.state.options?.null?.label).toBe("Not triaged");
  expect(Object.keys(exposure.fields.priority.options ?? {})).toEqual([
    "must",
    "should",
    "could",
    "wont",
    "null",
  ]);
});

test("the source snapshot stays off the wire", () => {
  expect(Object.keys(taskTriageShape.schema.shape)).not.toContain(
    "sourceTitle",
  );
  expect(Object.keys(taskTriageShape.schema.shape)).not.toContain(
    "sourceDescription",
  );
});
