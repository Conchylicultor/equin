/**
 * The exposed automation keeps the id saved task-list views name (`origin`,
 * over the `automationId` column) and reads NULL — by hand — for a task no
 * automation filed. The launch decision is exposed as `approval`, NULL — not
 * approved — for a task no one decided on.
 *
 * Run: `./equin test plugins/tasks/plugins/automations`.
 */

import { expect, test } from "bun:test";
import { tasksEntityRef } from "@plugins/tasks/plugins/tasks-core/core";
import { launchDecisionShape, taskOriginShape } from "./resources";

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

test("the launch decision is exposed on tasks as `approval`, NULL when undecided", () => {
  const exposure = launchDecisionShape.exposure;
  expect(exposure.parent).toBe(tasksEntityRef);
  expect(Object.keys(exposure.fields)).toEqual(["decision"]);
  expect(exposure.fields.decision).toMatchObject({
    id: "approval",
    label: "Approval",
    absent: null,
  });
});

test("a launch decision names no automation: it is the task's", () => {
  expect(Object.keys(launchDecisionShape.fields)).not.toContain("automationId");
});
