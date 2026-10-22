import { describe, expect, test } from "bun:test";
import type { CommitInfo } from "./commit-log";
import { deduplicateByPushId } from "./commit-log";
import {
  countByItemPoints,
  countPoints,
  linesByExtPoints,
  linesPoints,
} from "./series";

function commit(iso: string, over: Partial<CommitInfo> = {}): CommitInfo {
  return {
    sha: iso,
    iso,
    pushId: null,
    conversationId: null,
    added: 1,
    removed: 0,
    byExt: { ".ts": { added: 1, removed: 0 } },
    ...over,
  };
}

const commits = [
  commit("2026-01-01T10:00:00Z", { conversationId: "a" }),
  commit("2026-01-01T12:00:00Z", { conversationId: "b" }),
  commit("2026-01-03T09:00:00Z", { conversationId: "a" }),
];

describe("commit series", () => {
  test("cumulative counts carry the running total per day", () => {
    expect(countPoints(commits, { kind: "cumulative" })).toEqual([
      { x: "2026-01-01", count: 2 },
      { x: "2026-01-03", count: 3 },
    ]);
  });

  test("rate counts are per bucket", () => {
    expect(countPoints(commits, { kind: "rate", bucket: "hour" })).toEqual([
      { x: "2026-01-01 10:00", count: 1 },
      { x: "2026-01-01 12:00", count: 1 },
      { x: "2026-01-03 09:00", count: 1 },
    ]);
    expect(countPoints(commits, { kind: "rate", bucket: "month" })).toEqual([
      { x: "2026-01", count: 3 },
    ]);
  });

  test("by-item cumulative points are independent snapshots", () => {
    const items = new Map([["a", "P0"]]);
    const points = countByItemPoints(
      commits,
      { kind: "cumulative" },
      (c) => items.get(c.conversationId ?? "") ?? "Unknown",
    );
    expect(points).toEqual([
      { x: "2026-01-01", byItem: { P0: 1, Unknown: 1 } },
      { x: "2026-01-03", byItem: { P0: 2, Unknown: 1 } },
    ]);
  });

  test("lines and lines by extension", () => {
    expect(linesPoints(commits, { kind: "cumulative" })).toEqual([
      { x: "2026-01-01", added: 2, removed: 0 },
      { x: "2026-01-03", added: 3, removed: 0 },
    ]);
    const byExt = linesByExtPoints(commits, { kind: "cumulative" });
    expect(byExt).toEqual([
      { x: "2026-01-01", byExt: { ".ts": { added: 2, removed: 0 } } },
      { x: "2026-01-03", byExt: { ".ts": { added: 3, removed: 0 } } },
    ]);
  });

  test("dedup never writes into its input", () => {
    const input = [
      commit("2026-01-01T10:00:00Z", { pushId: "p" }),
      commit("2026-01-01T11:00:00Z", { pushId: "p" }),
    ];
    const merged = deduplicateByPushId(input);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.byExt[".ts"]).toEqual({ added: 2, removed: 0 });
    expect(input[0]!.byExt[".ts"]).toEqual({ added: 1, removed: 0 });
    expect(input[0]!.iso).toBe("2026-01-01T10:00:00Z");
  });
});
