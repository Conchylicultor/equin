import { describe, expect, test } from "bun:test";
import type { ToolCallEvent } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/core";
import { readToolSearch } from "./tool-search";

const call = (
  input: unknown,
  result?: { content: string; toolReferences?: string[] },
): ToolCallEvent => ({
  kind: "tool-call",
  at: "2026-09-29T00:00:00.000Z",
  toolUseId: "tu-1",
  name: "ToolSearch",
  input,
  result: result && { at: "2026-09-29T00:00:01.000Z", ...result },
});

describe("readToolSearch", () => {
  test("a select that loaded everything it named has nothing missing", () => {
    const s = readToolSearch(
      call(
        { query: "select:mcp__equin__add_task", max_results: 1 },
        { content: "", toolReferences: ["mcp__equin__add_task"] },
      ),
    );
    expect(s.mode).toBe("select");
    if (s.mode !== "select") return;
    expect(s.loaded?.map((t) => t.name)).toEqual(["add_task"]);
    expect(s.missing).toEqual([]);
  });

  test("a bare name is served by its full MCP id", () => {
    const s = readToolSearch(
      call(
        { query: "select:read_page, Grep" },
        { content: "", toolReferences: ["mcp__equin__read_page"] },
      ),
    );
    if (s.mode !== "select") throw new Error("expected select");
    expect(s.missing.map((t) => t.id)).toEqual(["Grep"]);
  });

  test("a select with no matches reports every name missing", () => {
    const s = readToolSearch(
      call(
        { query: "select:ListAgents" },
        { content: "No matching deferred tools found" },
      ),
    );
    if (s.mode !== "select") throw new Error("expected select");
    expect(s.loaded).toEqual([]);
    expect(s.missing.map((t) => t.id)).toEqual(["ListAgents"]);
  });

  test("an in-flight select is neither loaded nor missing", () => {
    const s = readToolSearch(call({ query: "select:WebFetch" }));
    if (s.mode !== "select") throw new Error("expected select");
    expect(s.loaded).toBeUndefined();
    expect(s.missing).toEqual([]);
  });

  test("a keyword query is a search with its ranked matches", () => {
    const s = readToolSearch(
      call(
        { query: "list agents team", max_results: 5 },
        { content: "", toolReferences: ["TaskList", "SendMessage"] },
      ),
    );
    expect(s).toEqual({
      mode: "search",
      query: "list agents team",
      maxResults: 5,
      matches: [
        { id: "TaskList", name: "TaskList" },
        { id: "SendMessage", name: "SendMessage" },
      ],
    });
  });
});
