import { describe, expect, it } from "vitest";
import { MAX_PAGE_SECTIONS } from "../../core";
import { createPageSectionRegistry } from "../internal/page-sections";

/** `n` sibling sections in document order, attached to a fresh body. */
function sections(n: number): HTMLElement[] {
  document.body.replaceChildren();
  return Array.from({ length: n }, () =>
    document.body.appendChild(document.createElement("section")),
  );
}

describe("page section registry", () => {
  it("lists a path's sections in document order, whatever order they mount in", () => {
    const r = createPageSectionRegistry();
    const [a, b, c] = sections(3);
    r.register("/about", c!, "landing/footer");
    r.register("/about", a!, "landing/hero");
    r.register("/about", b!, "landing/layers");
    expect(r.sectionsOf("/about")).toEqual([
      "landing/hero",
      "landing/layers",
      "landing/footer",
    ]);
  });

  it("keeps an unmounted section, and a remount does not list it twice", () => {
    const r = createPageSectionRegistry();
    const [a, b] = sections(2);
    const unmount = r.register("/about", a!, "landing/hero");
    r.register("/about", b!, "landing/footer");
    unmount();
    a!.remove();
    expect(r.sectionsOf("/about")).toEqual(["landing/hero", "landing/footer"]);
    r.register("/about", b!, "landing/footer");
    expect(r.sectionsOf("/about")).toEqual(["landing/hero", "landing/footer"]);
  });

  it("keeps each path's sections apart", () => {
    const r = createPageSectionRegistry();
    const [a, b] = sections(2);
    r.register("/about", a!, "landing/hero");
    r.register("/about/vision", b!, "vision/idea");
    expect(r.sectionsOf("/about")).toEqual(["landing/hero"]);
    expect(r.sectionsOf("/about/vision")).toEqual(["vision/idea"]);
    expect(r.sectionsOf("/about/apps")).toEqual([]);
  });

  it("refuses a long name and a page past the cap", () => {
    const r = createPageSectionRegistry();
    const els = sections(MAX_PAGE_SECTIONS + 1);
    expect(() => r.register("/", els[0]!, "x".repeat(65))).toThrow();
    els
      .slice(0, MAX_PAGE_SECTIONS)
      .forEach((el, i) => r.register("/", el, `p/s${i}`));
    expect(() =>
      r.register("/", els[MAX_PAGE_SECTIONS]!, "p/one-too-many"),
    ).toThrow();
  });
});
