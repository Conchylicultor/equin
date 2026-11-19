import { describe, test, expect } from "bun:test";
import { normalizeMessage } from "./message-identity";

describe("normalizeMessage", () => {
  test("replaces the tokens that vary between occurrences of one problem", () => {
    expect(normalizeMessage("conv-1789653369-gpuv timed out")).toBe(
      "<id> timed out",
    );
    expect(normalizeMessage("worktree att-1789665345-p1mc gone")).toBe(
      "worktree <id> gone",
    );
    expect(
      normalizeMessage("run 3f2504e0-4f89-11d3-9a0c-0305e82c3301 failed"),
    ).toBe("run <uuid> failed");
    expect(normalizeMessage("commit 9ffecc9b3a1d2e4f is stale")).toBe(
      "commit <hex> is stale",
    );
    expect(normalizeMessage("job 12345 exceeded 30s")).toBe(
      "job # exceeded #s",
    );
    expect(normalizeMessage("a\n  b\tc  ")).toBe("a b c");
  });

  test("keeps two genuinely different problems apart, and stays bounded", () => {
    expect(normalizeMessage("queue A wedged")).not.toBe(
      normalizeMessage("queue B wedged"),
    );
    expect(normalizeMessage("x".repeat(5_000)).length).toBe(200);
    expect(normalizeMessage("x".repeat(5_000), 4_000).length).toBe(4_000);
  });
});
