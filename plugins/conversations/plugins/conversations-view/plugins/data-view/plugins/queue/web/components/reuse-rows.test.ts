import { describe, expect, test } from "bun:test";
import { Rank } from "@plugins/primitives/plugins/rank/core";
import { reuseRows } from "./reuse-rows";

type Row = { id: string; title: string; rank: Rank | null; at: Date };

const row = (id: string, title = id, rank = "a0"): Row => ({
  id,
  title,
  rank: Rank.from(rank),
  at: new Date(1000),
});

describe("reuseRows", () => {
  test("the first computation is returned as is", () => {
    const next = [row("a")];
    expect(reuseRows(null, next)).toBe(next);
  });

  test("an unchanged recompute keeps the previous array and rows", () => {
    const prev = [row("a"), row("b")];
    // Fresh objects with equal fields — fresh Rank and Date instances too.
    expect(reuseRows(prev, [row("a"), row("b")])).toBe(prev);
  });

  test("one changed row is new; every other row keeps its identity", () => {
    const prev = [row("a"), row("b"), row("c")];
    const out = reuseRows(prev, [row("a"), row("b", "renamed"), row("c")]);
    expect(out).not.toBe(prev);
    expect(out[0]).toBe(prev[0]);
    expect(out[1]).not.toBe(prev[1]);
    expect(out[1]!.title).toBe("renamed");
    expect(out[2]).toBe(prev[2]);
  });

  test("a moved row keeps its identity at its new position", () => {
    const prev = [row("a"), row("b")];
    const out = reuseRows(prev, [row("b"), row("a")]);
    expect(out).not.toBe(prev);
    expect(out[0]).toBe(prev[1]);
    expect(out[1]).toBe(prev[0]);
  });

  test("a changed rank is a changed row", () => {
    const prev = [row("a", "a", "a0")];
    const out = reuseRows(prev, [row("a", "a", "a1")]);
    expect(out[0]).not.toBe(prev[0]);
  });

  test("an added or removed field is a changed row", () => {
    const prev = [row("a")];
    const out = reuseRows(prev, [{ ...row("a"), extra: 1 } as Row]);
    expect(out[0]).not.toBe(prev[0]);
  });
});
