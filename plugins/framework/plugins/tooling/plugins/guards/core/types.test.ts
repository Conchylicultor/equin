import { describe, expect, test } from "bun:test";
import { matchesTool } from "./types";

describe("matchesTool", () => {
  test("a built-in tool matches only itself", () => {
    expect(matchesTool("Bash", "Bash")).toBe(true);
    expect(matchesTool("Read", "ReadMcpResource")).toBe(false);
  });

  test("an MCP server matcher covers every tool of that server only", () => {
    const m = "mcp__claude-in-chrome__*" as const;
    expect(matchesTool(m, "mcp__claude-in-chrome__tabs_context_mcp")).toBe(
      true,
    );
    expect(matchesTool(m, "mcp__claude-in-chrome-x__navigate")).toBe(false);
    expect(matchesTool(m, "mcp__equin__browser_navigate")).toBe(false);
  });
});
