import { describe, expect, test } from "bun:test";
import { stepFlags } from "./queue-attach";

describe("stepFlags", () => {
  test("a group drawn beneath its supervisor is skipped by its neighbours' steps", () => {
    // a, b (attached beneath a), c
    const flags = stepFlags(["a", "b", "c"], (g) => g !== "b");
    expect(flags.get("a")).toEqual({
      isTop: true,
      isBottom: false,
      canStepDown: true,
    });
    expect(flags.get("b")).toEqual({
      isTop: false,
      isBottom: false,
      canStepDown: false,
    });
    expect(flags.get("c")).toEqual({
      isTop: false,
      isBottom: true,
      canStepDown: false,
    });
  });

  test("the last top-level group is the bottom even when an attached one follows it", () => {
    const flags = stepFlags(["a", "b"], (g) => g === "a");
    expect(flags.get("a")).toEqual({
      isTop: true,
      isBottom: true,
      canStepDown: false,
    });
  });
});
