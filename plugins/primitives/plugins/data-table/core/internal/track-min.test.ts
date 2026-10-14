import { describe, expect, test } from "bun:test";
import { floorAtLabel, trackMin } from "./track-min";

describe("floorAtLabel", () => {
  test("a zero minmax floor becomes the measured label", () => {
    expect(floorAtLabel("minmax(0,1fr)", 64)).toBe("minmax(64px, 1fr)");
    expect(floorAtLabel("minmax(0px, 2fr)", 40)).toBe("minmax(40px, 2fr)");
    expect(floorAtLabel("minmax(0,14rem)", 72)).toBe("minmax(72px, 14rem)");
  });

  test("unmeasured, or any other track, is its own", () => {
    expect(floorAtLabel("minmax(0,1fr)", undefined)).toBe("minmax(0,1fr)");
    for (const t of [
      "auto",
      "6rem",
      "1fr",
      "minmax(8rem,16rem)",
      "max-content",
    ]) {
      expect(floorAtLabel(t, 50)).toBe(t);
    }
    expect(floorAtLabel(undefined, 50)).toBe("auto");
  });
});

describe("trackMin", () => {
  test("a definite length counts as itself", () => {
    expect(trackMin("80px", 16)).toEqual({ kind: "px", px: 80 });
    expect(trackMin("6rem", 16)).toEqual({ kind: "px", px: 96 });
    expect(trackMin(" 5.5rem ", 10)).toEqual({ kind: "px", px: 55 });
  });

  test("minmax(a, b) counts as a", () => {
    expect(trackMin("minmax(8rem,16rem)", 16)).toEqual({ kind: "px", px: 128 });
    expect(trackMin("minmax(120px, 200px)", 16)).toEqual({
      kind: "px",
      px: 120,
    });
  });

  test("content- and space-sized tracks are measured", () => {
    for (const t of [
      undefined,
      "auto",
      "max-content",
      "1fr",
      "minmax(0,1fr)",
      "minmax(0,2fr)",
      "40%",
      "calc(2rem + 4px)",
    ]) {
      expect(trackMin(t, 16)).toEqual({ kind: "measured" });
    }
  });
});
