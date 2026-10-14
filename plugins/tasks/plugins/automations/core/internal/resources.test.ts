/**
 * The exposed automation keeps the id saved task-list views name (`origin`,
 * over the `automationId` column) and reads NULL — by hand — for a task no
 * automation filed.
 *
 * Run: `./singularity test plugins/tasks/plugins/automations`.
 */

import { expect, test } from "bun:test";
import { tasksEntityRef } from "@plugins/tasks/plugins/tasks-core/core";
import { taskOriginShape } from "./resources";

test("the filing automation is exposed on tasks as `origin`, NULL when by hand", () => {
  const exposure = taskOriginShape.exposure;
  expect(exposure.parent).toBe(tasksEntityRef);
  expect(Object.keys(exposure.fields)).toEqual(["automationId"]);
  expect(exposure.fields.automationId).toMatchObject({
    id: "origin",
    label: "Automation",
    absent: null,
  });
});
