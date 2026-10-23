import { describe, expect, test } from "bun:test";
import { stickyClasses, stickyMaskClasses } from "./sticky";

describe("stickyClasses", () => {
  test("default top edge, flush, raised layer", () => {
    expect(stickyClasses({ edge: "top", offset: "none", layer: "raised" })).toEqual({
      className: "sticky z-raised",
      style: { top: "0" },
    });
  });

  test("bottom edge maps to the bottom inset", () => {
    expect(stickyClasses({ edge: "bottom", offset: "none", layer: "raised" })).toEqual({
      className: "sticky z-raised",
      style: { bottom: "0" },
    });
  });

  test("a non-none offset reads the density --space var", () => {
    expect(stickyClasses({ edge: "top", offset: "sm", layer: "nav" })).toEqual({
      className: "sticky z-nav",
      style: { top: "var(--space-sm)" },
    });
  });

  test("left/right edges map to their insets", () => {
    expect(stickyClasses({ edge: "left", offset: "xs", layer: "float" })).toEqual({
      className: "sticky z-float",
      style: { left: "var(--space-xs)" },
    });
    expect(stickyClasses({ edge: "right", offset: "none", layer: "base" })).toEqual({
      className: "sticky z-base",
      style: { right: "0" },
    });
  });
});

describe("stickyMaskClasses", () => {
  test("no mask paints nothing", () => {
    expect(
      stickyMaskClasses({ mask: false, active: true, edge: "top" }),
    ).toEqual({
      className: undefined,
      edgeAttr: undefined,
    });
  });

  test("an opaque mask paints the chrome mask, with no tail", () => {
    expect(
      stickyMaskClasses({ mask: true, active: true, edge: "top" }),
    ).toEqual({
      className: "bg-chrome-mask",
      edgeAttr: undefined,
    });
  });

  test("a fade keeps the opaque band and hangs a tail off its edge", () => {
    expect(
      stickyMaskClasses({ mask: "fade", active: true, edge: "top" }),
    ).toEqual({
      className: "bg-chrome-mask sticky-fade",
      edgeAttr: "top",
    });
    expect(
      stickyMaskClasses({ mask: "fade", active: true, edge: "bottom" }),
    ).toEqual({
      className: "bg-chrome-mask sticky-fade",
      edgeAttr: "bottom",
    });
  });

  test("an inactive fade drops the tail — it would hang off an unpositioned box", () => {
    expect(
      stickyMaskClasses({ mask: "fade", active: false, edge: "top" }),
    ).toEqual({
      className: "bg-chrome-mask",
      edgeAttr: undefined,
    });
  });
});
