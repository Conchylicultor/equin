import { describe, expect, test } from "bun:test";
import { EXIT_WHEN_TEXT } from "@plugins/conversations/plugins/conversation-view/plugins/push-and-exit/plugins/capabilities/core";
import { nextStepAfterReport } from "./next-step";

describe("nextStepAfterReport", () => {
  test("follows the mandate's exit rule", () => {
    expect(nextStepAfterReport("when-done", false)).toContain(
      EXIT_WHEN_TEXT["when-done"],
    );
    expect(nextStepAfterReport("on-request", false)).toContain(
      EXIT_WHEN_TEXT["on-request"],
    );
  });
  test("a pending question waits for its answer", () => {
    expect(nextStepAfterReport("when-done", true)).not.toContain("exit_clean");
  });
  test("no exit grant leaves the conversation open", () => {
    expect(nextStepAfterReport(null, false)).toContain("do not close");
  });
});
