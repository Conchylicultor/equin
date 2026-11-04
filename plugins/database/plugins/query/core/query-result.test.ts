import { describe, expect, test } from "bun:test";
import {
  formatQueryDbResult,
  readQueryDbResult,
  type QueryDbResult,
} from "./query-result";

const RESULT: QueryDbResult = {
  database: "att-1792930305-o8uh17",
  columns: ["id", "title", "created_at"],
  rows: [
    {
      id: "task-1793145632-dxucy8",
      title: "Notification test task without auto-start",
      created_at: "2026-10-28T00:00:32.825Z",
    },
  ],
  rowCount: 1,
  truncated: false,
};

describe("query_db answer", () => {
  test("round-trips", () => {
    expect(readQueryDbResult(formatQueryDbResult(RESULT))).toEqual({
      kind: "result",
      result: RESULT,
    });
  });

  test("reads a real transcript payload", () => {
    const text =
      '{"database":"att-1792930305-o8uh17","columns":["id","title"],"rows":[{"id":"task-1793145729-ro6nc6","title":"Notification test with no action"}],"rowCount":1,"truncated":false}';
    const read = readQueryDbResult(text);
    expect(read.kind).toBe("result");
  });

  test("a failure message is unreadable", () => {
    expect(readQueryDbResult("column c.task_id does not exist")).toEqual({
      kind: "unreadable",
    });
  });
});
