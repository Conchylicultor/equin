import { afterEach, describe, expect, it } from "vitest";
import { flowAxis, layoutHost } from "../internal/layout-host";

function el(style: string, ...children: Element[]): HTMLElement {
  const e = document.createElement("div");
  e.setAttribute("style", style);
  for (const c of children) e.appendChild(c);
  return e;
}

// Computed style is only resolved for an element in a document (a detached one
// computes to "" in browsers, and in jsdom since 31), so every tree that is
// read for its layout is mounted.
function mounted<T extends Element>(root: T): T {
  document.body.appendChild(root);
  return root;
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("layoutHost", () => {
  it("is the direct parent when it draws a box", () => {
    const node = el("");
    const parent = mounted(el("display: flex", node));
    expect(layoutHost(node)).toBe(parent);
  });

  it("skips display: contents wrappers", () => {
    const node = el("");
    const host = mounted(
      el(
        "display: flex; flex-direction: column",
        el("display: contents", el("display: contents", node)),
      ),
    );
    expect(layoutHost(node)).toBe(host);
  });

  it("is null for a detached node", () => {
    expect(layoutHost(el(""))).toBeNull();
  });
});

describe("flowAxis", () => {
  it("is row for a row flex container", () => {
    expect(flowAxis(mounted(el("display: flex")))).toBe("row");
    expect(
      flowAxis(
        mounted(el("display: inline-flex; flex-direction: row-reverse")),
      ),
    ).toBe("row");
  });

  it("is column for a column flex container", () => {
    expect(flowAxis(mounted(el("display: flex; flex-direction: column")))).toBe(
      "column",
    );
  });

  it("is column for a non-flex box, whatever its flex-direction", () => {
    expect(flowAxis(mounted(el("display: block; flex-direction: row")))).toBe(
      "column",
    );
    expect(flowAxis(mounted(el("display: contents")))).toBe("column");
  });
});
