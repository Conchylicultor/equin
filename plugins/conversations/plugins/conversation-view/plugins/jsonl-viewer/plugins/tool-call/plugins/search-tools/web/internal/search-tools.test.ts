import { describe, expect, test } from "bun:test";
import type { ToolCallEvent } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/core";
import { parseSearchResult, readSearchCall } from "./search-tools";

const call = (name: string, input: unknown) =>
  ({ name, input }) as unknown as ToolCallEvent;

describe("readSearchCall", () => {
  test("a streaming input with nothing yet", () => {
    expect(readSearchCall(call("Grep", undefined))).toEqual({
      tool: "Grep",
      pattern: "",
      filters: [],
      shape: "files",
    });
  });
  test("filters and shape", () => {
    const c = readSearchCall(
      call("Grep", {
        pattern: "foo",
        path: "src",
        glob: "*.ts",
        output_mode: "content",
        "-i": true,
        "-C": 2,
      }),
    );
    expect(c.filters).toEqual(["in src", "glob *.ts", "-i", "-C 2"]);
    expect(c.shape).toBe("lines");
  });
  test("glob ignores grep-only fields", () => {
    expect(
      readSearchCall(call("Glob", { pattern: "**/*.ts", type: "js" })).filters,
    ).toEqual([]);
  });
});

describe("parseSearchResult", () => {
  test("files with header", () => {
    const o = parseSearchResult("files", "Found 2 files\na.ts\nb.ts");
    expect(o).toEqual({ count: 2, unit: "file", lines: ["a.ts", "b.ts"] });
  });
  test("no files", () => {
    expect(parseSearchResult("files", "No files found").count).toBe(0);
  });
  test("content lines skip separators in the count", () => {
    const o = parseSearchResult("lines", "a.ts:1:x\n--\na.ts:9:y");
    expect(o.count).toBe(2);
    expect(o.lines).toHaveLength(3);
  });
  test("counts use the harness total", () => {
    const o = parseSearchResult(
      "counts",
      "a.ts:3\nb.ts:2\n\nFound 5 total occurrences across 2 files.",
    );
    expect(o).toEqual({ count: 5, unit: "match", lines: ["a.ts:3", "b.ts:2"] });
  });
});
