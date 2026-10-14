import { describe, expect, test } from "bun:test";
import type { McpTool } from "./mcp";
import { toolsInScope } from "./scope";

function tool(name: string, profiles?: readonly string[]): McpTool {
  return {
    name,
    description: name,
    inputSchema: {},
    profiles,
    handler: () => ({ content: [] }),
  };
}

const tools = new Map(
  [
    tool("add_task"),
    tool("flag_raise"),
    tool("submit_transcription", ["sonata.transcription"]),
    tool("hello_only", ["scratch.hello"]),
  ].map((t) => [t.name, t]),
);
const names = (ts: McpTool[]) => ts.map((t) => t.name);

describe("toolsInScope", () => {
  test("the default scope sees every tool reserved for no profile", () => {
    expect(names(toolsInScope(tools, { kind: "default" }))).toEqual([
      "add_task",
      "flag_raise",
    ]);
  });

  test("a profile sees exactly its allowlist, reserved tools included", () => {
    expect(
      names(
        toolsInScope(tools, {
          kind: "profile",
          profile: "sonata.transcription",
          tools: ["submit_transcription", "flag_raise"],
        }),
      ),
    ).toEqual(["submit_transcription", "flag_raise"]);
  });

  test("a tool reserved for the profile but not on its allowlist stays hidden", () => {
    expect(
      names(
        toolsInScope(tools, {
          kind: "profile",
          profile: "sonata.transcription",
          tools: ["flag_raise"],
        }),
      ),
    ).toEqual(["flag_raise"]);
  });

  test("an allowlisted tool reserved for another profile throws", () => {
    expect(() =>
      toolsInScope(tools, {
        kind: "profile",
        profile: "sonata.transcription",
        tools: ["hello_only"],
      }),
    ).toThrow("reserved for scratch.hello");
  });

  test("an allowlisted tool that does not exist throws", () => {
    expect(() =>
      toolsInScope(tools, {
        kind: "profile",
        profile: "scratch.hello",
        tools: ["nope"],
      }),
    ).toThrow('names tool "nope", which is not registered');
  });
});
