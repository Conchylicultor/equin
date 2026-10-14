import { describe, expect, test } from "bun:test";
import { scrollClasses } from "./scroll";

const base = { fill: false, hideScrollbar: false, isolate: false };

describe("scrollClasses", () => {
  test("y axis clamps the horizontal axis to hidden", () => {
    expect(scrollClasses({ ...base, axis: "y" })).toBe(
      "overflow-y-auto overflow-x-hidden has-[[data-scrolls-x]]:overflow-x-auto has-[[data-scrolls-x]]:[container-type:inline-size]",
    );
  });

  test("x axis clamps the vertical axis to hidden", () => {
    expect(scrollClasses({ ...base, axis: "x" })).toBe(
      "overflow-x-auto overflow-y-hidden",
    );
  });

  test("both opens both axes", () => {
    expect(scrollClasses({ ...base, axis: "both" })).toBe("overflow-auto");
  });

  test("fill on y/both emits min-h-0 flex-1", () => {
    expect(scrollClasses({ ...base, axis: "y", fill: true })).toBe(
      "overflow-y-auto overflow-x-hidden has-[[data-scrolls-x]]:overflow-x-auto has-[[data-scrolls-x]]:[container-type:inline-size] min-h-0 flex-1",
    );
    expect(scrollClasses({ ...base, axis: "both", fill: true })).toBe(
      "overflow-auto min-h-0 flex-1",
    );
  });

  test("fill on x emits min-w-0 flex-1 instead", () => {
    expect(scrollClasses({ ...base, axis: "x", fill: true })).toBe(
      "overflow-x-auto overflow-y-hidden min-w-0 flex-1",
    );
  });

  test("hideScrollbar and isolate append their flags", () => {
    expect(
      scrollClasses({
        axis: "y",
        fill: false,
        hideScrollbar: true,
        isolate: true,
      }),
    ).toBe(
      "overflow-y-auto overflow-x-hidden has-[[data-scrolls-x]]:overflow-x-auto has-[[data-scrolls-x]]:[container-type:inline-size] no-scrollbar isolate",
    );
  });
});
