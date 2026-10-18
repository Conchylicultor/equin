import { describe, expect, test } from "bun:test";
import { isRecordedToolCall } from "./recorded-call";

describe("isRecordedToolCall", () => {
  test("a Bash call running an e2e script", () => {
    expect(
      isRecordedToolCall("Bash", {
        command: "./singularity run plugins/x/e2e/flow.ts --no-x",
      }),
    ).toBe(true);
    expect(isRecordedToolCall("Bash", { command: "./singularity build" })).toBe(
      false,
    );
    expect(
      isRecordedToolCall("Bash", {
        command: "./singularity run scripts/x.ts",
      }),
    ).toBe(false);
  });

  test("a page-changing browser_* MCP call", () => {
    expect(isRecordedToolCall("mcp__equin__browser_act", {})).toBe(true);
    expect(isRecordedToolCall("mcp__equin__browser_navigate", {})).toBe(true);
    expect(isRecordedToolCall("mcp__equin__browser_read_page", {})).toBe(false);
    expect(isRecordedToolCall("mcp__equin__browser_screenshot", {})).toBe(
      false,
    );
    expect(isRecordedToolCall("Read", {})).toBe(false);
  });
});
