import { describe, expect, test } from "bun:test";
import { claudeCodeBlockMessage } from "./status";

describe("claudeCodeBlockMessage", () => {
  test("names the problem and where in the app to fix it — never a command", () => {
    expect(claudeCodeBlockMessage({ kind: "signed-out", version: "1" })).toBe(
      "Claude Code is not signed in, so no agent can start. Sign in from the Claude Code row of the health report.",
    );
    expect(claudeCodeBlockMessage({ kind: "unreadable", error: "boom" })).toBe(
      "Couldn't check Claude Code: boom, so no agent can start.",
    );
  });
});
