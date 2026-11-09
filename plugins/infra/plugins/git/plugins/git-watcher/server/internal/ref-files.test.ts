import { describe, expect, test } from "bun:test";
import { planRefFollow, samePlan } from "./ref-files";

const dirs = (...present: string[]) => {
  const set = new Set(present);
  return async (p: string) => set.has(p);
};

describe("planRefFollow", () => {
  test("follows each tracked ref's loose file and packed-refs, nothing else", async () => {
    const plan = await planRefFollow(
      "/g",
      ["refs/heads/main", "refs/heads/claude-web/att-1"],
      dirs("/g/refs", "/g/refs/heads", "/g/refs/heads/claude-web"),
    );
    expect(plan.files).toEqual([
      "/g/packed-refs",
      "/g/refs/heads/claude-web/att-1",
      "/g/refs/heads/main",
    ]);
    expect([...plan.structural]).toEqual([]);
  });

  test("a nesting dir that is missing is followed as an entry of the deepest dir there", async () => {
    const plan = await planRefFollow(
      "/g",
      ["refs/heads/main", "refs/heads/a/b/c"],
      dirs("/g/refs", "/g/refs/heads"),
    );
    expect(plan.files).toEqual([
      "/g/packed-refs",
      "/g/refs/heads/a",
      "/g/refs/heads/main",
    ]);
    expect([...plan.structural]).toEqual(["/g/refs/heads/a"]);
    expect(plan.refFiles.has("/g/refs/heads/a")).toBe(false);
  });

  test("a plan changes when a nesting dir appears", async () => {
    const before = await planRefFollow(
      "/g",
      ["refs/heads/a/b"],
      dirs("/g/refs", "/g/refs/heads"),
    );
    const after = await planRefFollow(
      "/g",
      ["refs/heads/a/b"],
      dirs("/g/refs", "/g/refs/heads", "/g/refs/heads/a"),
    );
    expect(samePlan(before, after)).toBe(false);
    expect(after.files).toContain("/g/refs/heads/a/b");
    expect(samePlan(after, after)).toBe(true);
  });
});
