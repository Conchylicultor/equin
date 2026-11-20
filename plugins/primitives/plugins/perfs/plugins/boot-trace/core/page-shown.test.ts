import { describe, expect, test } from "bun:test";
import { notShownFromMs, pageShown, type PageShownRecords } from "./page-shown";

const base: PageShownRecords = {
  prerendering: false,
  activationStartMs: 0,
  visibilityEntries: [],
  recordedFirstHiddenMs: null,
  hiddenNow: false,
  nowMs: 10_000,
};

describe("pageShown", () => {
  test("no record of a hide: shown throughout", () => {
    expect(pageShown(base)).toEqual({ kind: "shown" });
    expect(
      pageShown({
        ...base,
        visibilityEntries: [{ name: "visible", startTime: 0 }],
      }),
    ).toEqual({ kind: "shown" });
  });

  test("a later hidden entry counts, not only the first one", () => {
    expect(
      pageShown({
        ...base,
        visibilityEntries: [
          { name: "visible", startTime: 0 },
          { name: "hidden", startTime: 1_200 },
          { name: "visible", startTime: 240_000 },
        ],
      }),
    ).toEqual({ kind: "hidden", atMs: 1_200 });
  });

  test("the earliest of every record wins", () => {
    expect(
      pageShown({
        ...base,
        visibilityEntries: [{ name: "hidden", startTime: 900 }],
        recordedFirstHiddenMs: 700,
        hiddenNow: true,
      }),
    ).toEqual({ kind: "hidden", atMs: 700 });
    expect(pageShown({ ...base, hiddenNow: true })).toEqual({
      kind: "hidden",
      atMs: 10_000,
    });
  });

  test("prerendering, now or before activation, is its own answer", () => {
    expect(pageShown({ ...base, prerendering: true })).toEqual({
      kind: "prerendered",
    });
    expect(pageShown({ ...base, activationStartMs: 183_000 })).toEqual({
      kind: "prerendered",
    });
  });

  test("notShownFromMs", () => {
    expect(notShownFromMs({ kind: "shown" })).toBeNull();
    expect(notShownFromMs({ kind: "hidden", atMs: 5 })).toBe(5);
    expect(notShownFromMs({ kind: "prerendered" })).toBe(0);
  });
});
