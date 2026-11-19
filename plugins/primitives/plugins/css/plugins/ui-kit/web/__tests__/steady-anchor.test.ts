import { afterEach, describe, expect, it } from "vitest";
import {
  steadyAnchor as makeSteadyAnchor,
  type PopoverAnchorLostFault,
} from "../components/steady-anchor";

/**
 * A popover's anchor that loses its box (detached, or hidden under
 * `display: none`) must not hand Floating UI the empty rect at the viewport's
 * origin — that is the panel jumping to the screen's top-left corner. jsdom
 * draws no layout, so the anchor's boxes are stubbed.
 */

afterEach(() => {
  document.body.innerHTML = "";
  faults = [];
});

let faults: PopoverAnchorLostFault[] = [];

function steadyAnchor(target: Element) {
  return makeSteadyAnchor(target, null, { current: null }, (f) =>
    faults.push(f),
  );
}

function boxed(el: Element, rect: DOMRect | null) {
  el.getClientRects = () => (rect ? [rect] : []) as unknown as DOMRectList;
  el.getBoundingClientRect = () => rect ?? new DOMRect();
}

describe("steadyAnchor", () => {
  it("measures the anchor while it has a box", () => {
    const btn = document.body.appendChild(document.createElement("button"));
    boxed(btn, new DOMRect(1276, 7, 78, 32));
    const anchor = steadyAnchor(btn);
    expect(anchor.getBoundingClientRect().x).toBe(1276);
    expect(anchor.contextElement).toBe(btn);
  });

  it("keeps the last rect once the anchor is hidden, and reports the loss once", () => {
    const bar = document.body.appendChild(document.createElement("div"));
    const btn = bar.appendChild(document.createElement("button"));
    boxed(btn, new DOMRect(1276, 7, 78, 32));
    const anchor = steadyAnchor(btn);
    anchor.getBoundingClientRect();

    bar.style.display = "none";
    boxed(btn, null);
    expect(anchor.getBoundingClientRect().x).toBe(1276);
    expect(anchor.getBoundingClientRect().y).toBe(7);
    expect(faults).toHaveLength(1);
    expect(faults[0]).toMatchObject({
      cause: "no-box",
      anchor: btn,
      hiddenBy: bar,
    });
  });

  it("re-arms when the box comes back, and follows it", () => {
    const btn = document.body.appendChild(document.createElement("button"));
    boxed(btn, new DOMRect(10, 10, 5, 5));
    const anchor = steadyAnchor(btn);
    anchor.getBoundingClientRect();
    boxed(btn, null);
    anchor.getBoundingClientRect();
    boxed(btn, new DOMRect(40, 10, 5, 5));
    expect(anchor.getBoundingClientRect().x).toBe(40);
    boxed(btn, null);
    expect(anchor.getBoundingClientRect().x).toBe(40);
    expect(faults).toHaveLength(2);
  });

  it("names a detached anchor as detached", () => {
    const btn = document.body.appendChild(document.createElement("button"));
    boxed(btn, new DOMRect(10, 10, 5, 5));
    const anchor = steadyAnchor(btn);
    anchor.getBoundingClientRect();
    btn.remove();
    expect(anchor.getBoundingClientRect().x).toBe(10);
    expect(faults[0]).toMatchObject({ cause: "detached", hiddenBy: null });
  });
});
