import { describe, expect, test } from "bun:test";
import { formatBacklog, readBacklog, type BacklogLine } from "./backlog-text";

const lines: BacklogLine[] = [
  {
    taskId: "task-1",
    track: "sidequest",
    status: null,
    title: "map-in-sync exceeds the budget (5,086 calls, mostly the cache)",
    filedFrom: "task-9",
  },
  {
    taskId: "task-2",
    track: "main",
    status: "held",
    title: "A [bracketed] title",
    filedFrom: null,
  },
];

describe("backlog text", () => {
  test("round-trips every line", () => {
    const read = readBacklog(formatBacklog(lines, 200));
    expect(read.count).toBe(2);
    expect(read.truncated).toBe(false);
    expect(read.lines).toEqual(lines.map((l) => ({ kind: "task", ...l })));
  });

  test("a list cut at the limit says so", () => {
    const read = readBacklog(formatBacklog(lines, 2));
    expect(read.count).toBe(2);
    expect(read.truncated).toBe(true);
  });

  test("the empty sentence reads as zero tasks", () => {
    expect(readBacklog(formatBacklog([], 200))).toEqual({
      count: 0,
      truncated: false,
      lines: [],
    });
  });

  test("reads a transcript's real answer", () => {
    const read = readBacklog(
      "Backlog (1):\n- task-1794615226-sogl1h [sidequest] web-artifacts:map-in-sync exceeds the 1000 own-file-call budget (5,086 calls, mostly the artifact cache) (filed from task-1794374645-ja69ab)",
    );
    expect(read.lines).toEqual([
      {
        kind: "task",
        taskId: "task-1794615226-sogl1h",
        track: "sidequest",
        status: null,
        title:
          "web-artifacts:map-in-sync exceeds the 1000 own-file-call budget (5,086 calls, mostly the artifact cache)",
        filedFrom: "task-1794374645-ja69ab",
      },
    ]);
  });

  test("text it cannot read stays text", () => {
    const read = readBacklog(
      "This conversation is not a supervisor role's session.",
    );
    expect(read.count).toBeNull();
    expect(read.lines).toEqual([
      {
        kind: "text",
        text: "This conversation is not a supervisor role's session.",
      },
    ]);
  });
});
