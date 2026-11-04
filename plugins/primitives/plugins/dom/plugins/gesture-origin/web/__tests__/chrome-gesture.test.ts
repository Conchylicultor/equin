import { describe, expect, it } from "vitest";
import { isChromeGesture } from "../internal/chrome-gesture";

function header(inner: string): HTMLElement {
  const el = document.createElement("div");
  el.innerHTML = inner;
  document.body.append(el);
  return el;
}

describe("isChromeGesture", () => {
  it("accepts a gesture on the surface's own non-text content", () => {
    const el = header("<span>Title</span>");
    const target = el.querySelector("span");
    expect(isChromeGesture({ target, currentTarget: el })).toBe(true);
    expect(
      isChromeGesture({
        target: target?.firstChild ?? null,
        currentTarget: el,
      }),
    ).toBe(true);
  });

  it("rejects a gesture bubbled from outside its DOM (a portal)", () => {
    const el = header("<span>Title</span>");
    const portaled = header("<p>Popover text</p>").querySelector("p");
    expect(isChromeGesture({ target: portaled, currentTarget: el })).toBe(
      false,
    );
  });

  it("rejects a gesture in text entry", () => {
    const el = header(
      '<input /><textarea></textarea><div contenteditable="true"><b>x</b></div>',
    );
    for (const sel of ["input", "textarea", "b"]) {
      const target = el.querySelector(sel);
      expect(isChromeGesture({ target, currentTarget: el })).toBe(false);
    }
  });
});
