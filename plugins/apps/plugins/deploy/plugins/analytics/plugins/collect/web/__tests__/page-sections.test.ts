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
    r.register("/website", c!, "landing/footer");
    r.register("/website", a!, "landing/hero");
    r.register("/website", b!, "landing/layers");
    expect(r.sectionsOf("/website")).toEqual([
      "landing/hero",
      "landing/layers",
      "landing/footer",
    ]);
  });

  it("keeps an unmounted section, and a remount does not list it twice", () => {
    const r = createPageSectionRegistry();
    const [a, b] = sections(2);
    const unmount = r.register("/website", a!, "landing/hero");
    r.register("/website", b!, "landing/footer");
    unmount();
    a!.remove();
    expect(r.sectionsOf("/website")).toEqual([
      "landing/hero",
      "landing/footer",
    ]);
    r.register("/website", b!, "landing/footer");
    expect(r.sectionsOf("/website")).toEqual([
      "landing/hero",
      "landing/footer",
    ]);
  });

  it("keeps each path's sections apart", () => {
    const r = createPageSectionRegistry();
    const [a, b] = sections(2);
    r.register("/website", a!, "landing/hero");
    r.register("/website/vision", b!, "vision/idea");
    expect(r.sectionsOf("/website")).toEqual(["landing/hero"]);
    expect(r.sectionsOf("/website/vision")).toEqual(["vision/idea"]);
    expect(r.sectionsOf("/website/apps")).toEqual([]);
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
