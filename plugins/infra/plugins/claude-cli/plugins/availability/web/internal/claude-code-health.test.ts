import { describe, expect, test } from "bun:test";
import type { ResourceResult } from "@plugins/primitives/plugins/live-state/web";
import type { ClaudeCodeStatus } from "../../core";
import { claudeCodeVerdict } from "./claude-code-health";

const refetch = () => Promise.resolve();
const loaded = (data: ClaudeCodeStatus): ResourceResult<ClaudeCodeStatus> => ({
  status: "ready",
  data,
  refetch,
});

describe("claudeCodeVerdict", () => {
  test("is unknown, not ok, while loading", () => {
    expect(
      claudeCodeVerdict({
        status: "loading",
        refetch,
      }),
    ).toEqual({
      state: "unknown",
    });
  });

  test("is ok when signed in, naming account and version", () => {
    expect(
      claudeCodeVerdict(
        loaded({
          kind: "ready",
          version: "2.1.282",
          authMethod: "claude.ai",
          email: "a@b.c",
        }),
      ),
    ).toEqual({ state: "ok", summary: "Signed in as a@b.c · v2.1.282" });
  });

  test("is critical when missing or signed out", () => {
    expect(
      claudeCodeVerdict(loaded({ kind: "missing", searched: [] })).state,
    ).toBe("critical");
    expect(
      claudeCodeVerdict(loaded({ kind: "signed-out", version: "1" })).state,
    ).toBe("critical");
  });

  test("is unknown, with why, when the check itself failed", () => {
    expect(
      claudeCodeVerdict(loaded({ kind: "unreadable", error: "timed out" })),
    ).toEqual({
      state: "unknown",
      summary: "Couldn't check Claude Code: timed out",
    });
  });

  test("is not applicable, with why, where no computer can answer", () => {
    expect(
      claudeCodeVerdict({ status: "unavailable", message: "Not here." }),
    ).toEqual({ state: "not-applicable", summary: "Not here." });
  });
});
