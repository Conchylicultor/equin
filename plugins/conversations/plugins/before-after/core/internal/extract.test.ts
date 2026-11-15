import { describe, expect, test } from "bun:test";
import type { JsonlEvent } from "@plugins/conversations/plugins/transcript-source/core";
import { extractBeforeAfterHits } from "./extract";

const AT = "2026-11-15T00:00:00Z";

const call = (name: string, result?: Record<string, unknown>) =>
  ({
    kind: "tool-call",
    at: AT,
    toolUseId: "toolu_1",
    name,
    input: { route: "/agents", title: "Agents" },
    ...(result ? { result: { at: AT, content: "", ...result } } : {}),
  }) as JsonlEvent;

const HIT = {
  kind: "before-after",
  key: "toolu_1",
  relation: "created",
  at: AT,
} as const;

describe("extractBeforeAfterHits", () => {
  test("a register_before_after call is one pair, keyed by its tool-use id", () => {
    expect(
      extractBeforeAfterHits(call("mcp__equin__register_before_after")),
    ).toEqual([HIT]);
    expect(
      extractBeforeAfterHits(
        call("mcp__equin__register_before_after", { content: "ba-1-abcdef" }),
      ),
    ).toEqual([HIT]);
  });

  test("a failed call registered nothing; an interrupted one may have", () => {
    expect(
      extractBeforeAfterHits(
        call("mcp__equin__register_before_after", { isError: true }),
      ),
    ).toEqual([]);
    expect(
      extractBeforeAfterHits(
        call("mcp__equin__register_before_after", {
          isError: true,
          outcomeUnknown: true,
        }),
      ),
    ).toEqual([HIT]);
  });

  test("other calls are not pairs", () => {
    expect(
      extractBeforeAfterHits(call("mcp__equin__browser_screenshot")),
    ).toEqual([]);
    expect(extractBeforeAfterHits(call("register_before_after"))).toEqual([]);
    expect(
      extractBeforeAfterHits({ kind: "user", at: AT } as unknown as JsonlEvent),
    ).toEqual([]);
  });
});
