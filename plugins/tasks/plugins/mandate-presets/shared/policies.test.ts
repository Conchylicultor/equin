import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  defineCapability,
  scopeKey,
} from "@plugins/tasks/plugins/orchestration/plugins/mandate/plugins/policy/core";
import { exitClean } from "@plugins/conversations/plugins/conversation-view/plugins/push-and-exit/plugins/capabilities/core";
import { tasksFile, tasksManage } from "@plugins/tasks/plugins/tasks-core/core";
import { interactivePolicy, supervisorPolicy } from "./policies";

describe("exit.clean in the presets", () => {
  test("an interactive agent closes when the user asks", () => {
    expect(interactivePolicy()[exitClean.id]).toBe("on-request");
  });

  test("a supervisor's root closes on request, its workers once they are done", () => {
    const policy = supervisorPolicy() as Record<string, unknown>;
    expect(policy[exitClean.id]).toBeUndefined();
    expect(policy[scopeKey("root")]).toMatchObject({
      [exitClean.id]: "on-request",
    });
    expect(policy[scopeKey("below")]).toMatchObject({
      [exitClean.id]: "when-done",
    });
  });
});

describe("tasks.manage in the presets", () => {
  test("only a supervisor's root may edit and drop its tree's tasks", () => {
    expect(interactivePolicy()[tasksManage.id]).toBeUndefined();
    const policy = supervisorPolicy() as Record<string, unknown>;
    expect(policy[tasksManage.id]).toBeUndefined();
    expect(policy[scopeKey("root")]).toMatchObject({ [tasksManage.id]: true });
    expect(policy[scopeKey("below")]).not.toHaveProperty(tasksManage.id);
  });
});

describe("tasks.file in the presets", () => {
  test("a supervisor's root files with no default dependency, its workers after their own task", () => {
    expect(interactivePolicy()[tasksFile.id]).not.toHaveProperty(
      "defaultAfter",
    );
    const policy = supervisorPolicy() as Record<string, unknown>;
    expect(policy[tasksFile.id]).toBeUndefined();
    expect(policy[scopeKey("root")]).toMatchObject({
      [tasksFile.id]: { defaultAfter: "none" },
    });
    expect(
      (policy[scopeKey("below")] as Record<string, unknown>)[tasksFile.id],
    ).not.toHaveProperty("defaultAfter");
  });
});

describe("the backlog destination in the presets", () => {
  test("an interactive agent and every supervisor conversation may file into a role's backlog", () => {
    expect(
      (interactivePolicy()[tasksFile.id] as Record<string, unknown>).backlog,
    ).toBe(true);
    const policy = supervisorPolicy() as Record<string, unknown>;
    for (const scope of ["root", "below"] as const) {
      const scoped = policy[scopeKey(scope)] as Record<string, unknown>;
      expect((scoped[tasksFile.id] as Record<string, unknown>).backlog).toBe(
        true,
      );
    }
  });
});

describe("supervisorPolicy(extra)", () => {
  test("adds the extra grants to their scope, and refuses one the preset already grants", () => {
    const extra = defineCapability<true>({
      id: "test.extra",
      schema: z.literal(true),
      label: "Extra",
    });
    const policy = supervisorPolicy({ root: [extra.grant(true)] }) as Record<
      string,
      unknown
    >;
    expect(policy[scopeKey("root")]).toMatchObject({ "test.extra": true });
    expect(policy[scopeKey("below")]).not.toHaveProperty("test.extra");
    expect(() => supervisorPolicy({ root: [tasksManage.grant(true)] })).toThrow(
      /granted twice/,
    );
  });
});
