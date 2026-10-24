import { describe, expect, test } from "bun:test";
import { CLI_NAMES } from "@plugins/framework/plugins/cli/plugins/cli-name/core";
import { isRecordedToolCall } from "./recorded-call";

describe("isRecordedToolCall", () => {
  test("a Bash call running an e2e script", () => {
    expect(
      isRecordedToolCall("Bash", {
        command: "./equin run plugins/x/e2e/flow.ts --no-x",
      }),
    ).toBe(true);
    expect(isRecordedToolCall("Bash", { command: "./equin build" })).toBe(
      false,
    );
    expect(
      isRecordedToolCall("Bash", {
        command: "./equin run scripts/x.ts",
      }),
    ).toBe(false);
  });

  test("an e2e run under any of the CLI's names", () => {
    for (const name of CLI_NAMES) {
      expect(
        isRecordedToolCall("Bash", {
          command: `./${name} run plugins/x/e2e/flow.ts`,
        }),
      ).toBe(true);
    }
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
