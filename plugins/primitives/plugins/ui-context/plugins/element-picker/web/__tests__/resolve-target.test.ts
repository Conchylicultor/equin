import { describe, test, expect, afterEach } from "vitest";
import { resolveTarget } from "../internal/resolve-target";

// jsdom has no layout engine: every element reports zero client rects and
// `elementFromPoint` is unimplemented. Both are stubbed per test — geometry via
// `box()`, and the browser's hit test via `seed()` (which is precisely the input
// `resolveTarget` is built to *distrust*, so faking it is the point).

/** Give an element a single box, the way a laid-out browser would. */
function box(
  el: Element,
  left: number,
  top: number,
  right: number,
  bottom: number,
): void {
  const rect = {
    left,
    top,
    right,
    bottom,
    width: right - left,
    height: bottom - top,
  };
  Object.defineProperty(el, "getClientRects", {
    value: () => [rect],
    configurable: true,
  });
}

/**
 * Stub what the browser's `pointer-events`-honouring hit test would return.
 * `defineProperty` rather than `vi.spyOn`: jsdom doesn't implement
 * `elementFromPoint` at all, so there is no property to spy on.
 */
function seed(el: Element | null): void {
  Object.defineProperty(document, "elementFromPoint", {
    value: () => el,
    configurable: true,
  });
}

afterEach(() => {
  Reflect.deleteProperty(document, "elementFromPoint");
  document.body.innerHTML = "";
});

describe("resolveTarget", () => {
  test("descends into a pointer-events:none control the browser hit test skipped", () => {
    // The action-bar shape: a wrapper whose child button is disabled (and so
    // `pointer-events:none`), which is why the browser hit test stops at the wrapper.
    document.body.innerHTML = `<div id="bar"><button id="picker" disabled></button></div>`;
    const bar = document.getElementById("bar")!;
    const picker = document.getElementById("picker")!;
    box(bar, 0, 0, 200, 32);
    box(picker, 100, 4, 128, 28);
    seed(bar);

    expect(resolveTarget(110, 16)).toBe(picker);
  });

  test("returns the seed when the point misses every child", () => {
    document.body.innerHTML = `<div id="bar"><button id="picker"></button></div>`;
    const bar = document.getElementById("bar")!;
    box(bar, 0, 0, 200, 32);
    box(document.getElementById("picker")!, 100, 4, 128, 28);
    seed(bar);

    expect(resolveTarget(10, 16)).toBe(bar);
  });

  test("stops at the control hosting an icon rather than reporting svg internals", () => {
    document.body.innerHTML = `<button id="b"><svg id="s"><path id="p"></path></svg></button>`;
    const button = document.getElementById("b")!;
    const svg = document.getElementById("s")!;
    const path = document.getElementById("p")!;
    box(button, 0, 0, 32, 32);
    box(svg, 8, 8, 24, 24);
    box(path, 10, 10, 22, 22);
    seed(button);

    expect(resolveTarget(16, 16)).toBe(button);
  });

  test("traverses boxless marker spans without ever selecting one", () => {
    // The slot middleware's `display:contents` span generates no box of its own.
    document.body.innerHTML = `<div id="bar"><span id="marker" data-slot-id="X"><button id="b"></button></span></div>`;
    const bar = document.getElementById("bar")!;
    const button = document.getElementById("b")!;
    box(bar, 0, 0, 200, 32);
    box(button, 100, 4, 128, 28); // the marker span itself keeps jsdom's zero rects
    seed(bar);

    expect(resolveTarget(110, 16)).toBe(button);
  });

  test("never descends into the inspector's own chrome", () => {
    // The overlay portals to `document.body`, so it is a descendant of the seed
    // whenever the pointer is over a body-level element.
    document.body.innerHTML = `<div id="overlay" data-element-picker><div id="highlight"></div></div>`;
    const overlay = document.getElementById("overlay")!;
    box(overlay, 0, 0, 800, 600);
    box(document.getElementById("highlight")!, 0, 0, 200, 32);
    box(document.body, 0, 0, 800, 600);
    seed(document.body);

    expect(resolveTarget(10, 16)).toBe(document.body);
  });

  test("reports nothing when the browser hit test lands on picker chrome", () => {
    document.body.innerHTML = `<div data-element-picker><span id="hint"></span></div>`;
    seed(document.getElementById("hint")!);

    expect(resolveTarget(10, 16)).toBeNull();
  });

  test("skips hidden subtrees", () => {
    document.body.innerHTML = `<div id="bar"><button id="b" style="visibility: hidden"></button></div>`;
    const bar = document.getElementById("bar")!;
    box(bar, 0, 0, 200, 32);
    box(document.getElementById("b")!, 100, 4, 128, 28);
    seed(bar);

    expect(resolveTarget(110, 16)).toBe(bar);
  });

  test("prefers the later sibling among equally deep candidates", () => {
    document.body.innerHTML = `<div id="bar"><button id="under"></button><button id="over"></button></div>`;
    const bar = document.getElementById("bar")!;
    const over = document.getElementById("over")!;
    box(bar, 0, 0, 200, 32);
    box(document.getElementById("under")!, 100, 4, 128, 28);
    box(over, 100, 4, 128, 28); // overlapping, painted on top
    seed(bar);

    expect(resolveTarget(110, 16)).toBe(over);
  });

  test("a split row's hit-area layer resolves to the row, never to itself", () => {
    // Row with actions: a box holding the control button, whose aria-hidden
    // hit-area span spreads over the whole box (padding included).
    document.body.innerHTML = `<div id="row"><button id="ctl"><span id="label">Feel</span><span id="hit" aria-hidden="true"></span></button></div>`;
    const row = document.getElementById("row")!;
    const ctl = document.getElementById("ctl")!;
    const hit = document.getElementById("hit")!;
    box(row, 0, 0, 380, 42);
    box(ctl, 16, 12, 270, 30);
    box(document.getElementById("label")!, 40, 12, 80, 30);
    box(hit, 0, 0, 380, 42);

    // The padding, left of the button: the browser hits the layer.
    seed(hit);
    expect(resolveTarget(5, 21)).toBe(row);
    // Over the button but beside its label: the button, not the layer.
    expect(resolveTarget(200, 21)).toBe(ctl);
    // Seeded at the row (a hit-area under the content): still never the layer.
    seed(row);
    expect(resolveTarget(5, 21)).toBe(row);
  });
});
