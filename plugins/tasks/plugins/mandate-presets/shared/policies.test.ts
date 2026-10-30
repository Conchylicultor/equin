import { describe, expect, test } from "bun:test";
import { scopeKey } from "@plugins/tasks/plugins/orchestration/plugins/mandate/plugins/policy/core";
import { exitClean } from "@plugins/conversations/plugins/conversation-view/plugins/push-and-exit/plugins/capabilities/core";
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
