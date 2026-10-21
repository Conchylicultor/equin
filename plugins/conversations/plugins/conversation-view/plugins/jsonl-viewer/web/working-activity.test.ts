import { describe, expect, test } from "bun:test";
import type { JsonlEvent } from "@plugins/conversations/plugins/transcript-source/core";
import { workingActivityOf } from "./working-activity";

const at = "2026-10-21T10:00:00.000Z";
const call = (name: string, input: unknown, done = false): JsonlEvent => ({
  kind: "tool-call",
  at,
  toolUseId: `t-${name}`,
  name,
  input,
  ...(done ? { result: { at, content: "ok" } } : {}),
});

describe("workingActivityOf", () => {
  test("a streaming reply is writing, whatever the transcript says", () => {
    expect(
      workingActivityOf([call("Read", { file_path: "/a/b.ts" })], true),
    ).toEqual({
      mood: "writing",
      label: "Writing",
    });
  });

  test("a call without a result names the tool and its file", () => {
    expect(
      workingActivityOf(
        [call("Read", { file_path: "/repo/web/app.tsx" })],
        false,
      ),
    ).toEqual({
      mood: "tool",
      label: "Reading app.tsx",
    });
    expect(
      workingActivityOf([call("Edit", { file_path: "x/row.tsx" })], false)
        .label,
    ).toBe("Editing row.tsx");
    expect(
      workingActivityOf([call("mcp__equin__query_db", {})], false).label,
    ).toBe("Running query_db");
  });

  test("a call with its result back is the model thinking about it", () => {
    expect(
      workingActivityOf([call("Bash", { command: "ls" }, true)], false).mood,
    ).toBe("thinking");
  });

  test("bookkeeping events are skipped", () => {
    const events: JsonlEvent[] = [
      call("Grep", { pattern: "x" }),
      { kind: "file-checkpoint", at, path: "/a", created: false },
    ];
    expect(workingActivityOf(events, false)).toEqual({
      mood: "tool",
      label: "Searching the code",
    });
  });

  test("nothing yet is plain working", () => {
    expect(workingActivityOf([], false)).toEqual({
      mood: "working",
      label: "Working",
    });
  });
});
