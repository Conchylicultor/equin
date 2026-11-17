import { describe, expect, test } from "bun:test";
import { claudeCodeBlockMessage } from "./status";

describe("claudeCodeBlockMessage", () => {
  test("names the problem — never a command, nor a place elsewhere", () => {
    expect(claudeCodeBlockMessage({ kind: "signed-out", version: "1" })).toBe(
      "Claude Code is not signed in, so no agent can start.",
    );
    expect(
      claudeCodeBlockMessage({ kind: "sign-in-refused", version: "1" }),
    ).toBe(
      "Claude refused this computer's sign-in (it may have expired), so no agent can start.",
    );
    expect(claudeCodeBlockMessage({ kind: "unreadable", error: "boom" })).toBe(
      "Couldn't check Claude Code: boom, so no agent can start.",
    );
  });
});
