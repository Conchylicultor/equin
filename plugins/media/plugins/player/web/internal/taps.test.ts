import { describe, expect, it } from "bun:test";
import { DOUBLE_TAP_MS, SEEK_RUN_MS } from "./geometry";
import { NO_TAPS, judgeTap, sideAt } from "./taps";

describe("sideAt", () => {
  it("splits the picture into left, middle and right", () => {
    expect(sideAt(0.1)).toBe("left");
    expect(sideAt(0.5)).toBe("mid");
    expect(sideAt(0.9)).toBe("right");
  });
});

describe("judgeTap", () => {
  it("a lone side tap waits for a second one; a middle tap does not", () => {
    expect(judgeTap(NO_TAPS, 0, "left").verdict).toEqual({
      kind: "tap",
      delay: DOUBLE_TAP_MS,
    });
    expect(judgeTap(NO_TAPS, 0, "mid").verdict).toEqual({
      kind: "tap",
      delay: 0,
    });
  });

  it("two quick taps on one side seek; on two sides they do not", () => {
    const first = judgeTap(NO_TAPS, 0, "right");
    expect(judgeTap(first.memory, 100, "right").verdict).toEqual({
      kind: "seek",
      side: "right",
    });
    expect(judgeTap(first.memory, 100, "left").verdict.kind).toBe("tap");
    expect(
      judgeTap(first.memory, DOUBLE_TAP_MS + 1, "right").verdict.kind,
    ).toBe("tap");
  });

  it("the middle has no double-tap", () => {
    const first = judgeTap(NO_TAPS, 0, "mid");
    expect(judgeTap(first.memory, 50, "mid").verdict.kind).toBe("tap");
  });

  it("while a seek runs, each single tap on its side seeks again", () => {
    let m = judgeTap(NO_TAPS, 0, "left").memory;
    m = judgeTap(m, 100, "left").memory;
    const third = judgeTap(m, 100 + SEEK_RUN_MS - 1, "left");
    expect(third.verdict).toEqual({ kind: "seek", side: "left" });
    expect(judgeTap(m, 100 + SEEK_RUN_MS + 1, "left").verdict.kind).toBe("tap");
  });
});
