import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { useRowFold } from "../internal/use-row-fold";

// jsdom has neither the Web Animations API nor layout: stand in for both, and
// hold animation frames so a test decides when the next one runs. Every row is
// 20px tall, laid out one under the other in DOM order.
interface FakeAnimation {
  el: Element;
  keyframes: Keyframe[];
  onfinish: (() => void) | null;
  cancelled: boolean;
  cancel: () => void;
  startTime: number | null;
}
const setupAnimate = Element.prototype.animate;
let animations: FakeAnimation[] = [];
let frames: Map<number, FrameRequestCallback> = new Map();
let nextFrameId = 0;
const ROW = 20;

beforeEach(() => {
  animations = [];
  frames = new Map();
  Element.prototype.animate = function (this: Element, keyframes) {
    const anim: FakeAnimation = {
      el: this,
      keyframes: keyframes as Keyframe[],
      onfinish: null,
      cancelled: false,
      cancel() {
        this.cancelled = true;
      },
      startTime: null,
    };
    animations.push(anim);
    return anim as unknown as Animation;
  };
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
    frames.set(++nextFrameId, cb);
    return nextFrameId;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
    frames.delete(id);
  });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      const index = this.parentElement
        ? [...this.parentElement.children].indexOf(this)
        : 0;
      return DOMRect.fromRect({
        x: 0,
        y: index * ROW,
        width: 100,
        height: ROW,
      });
    },
  );
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  Element.prototype.animate = setupAnimate;
});

function nextFrame() {
  const pending = [...frames.values()];
  frames = new Map();
  act(() => pending.forEach((cb) => cb(performance.now())));
}

function List({
  items,
  openKeys,
}: {
  items: string[];
  openKeys: ReadonlySet<string> | undefined;
}) {
  const fold = useRowFold({
    items,
    getKey: (s) => s,
    openKeys,
    isStandIn: (s) => s.endsWith(":loading"),
  });
  return (
    <div {...fold.hostProps}>
      {fold.items.map((item) => (
        <div key={item} {...fold.rowProps(item)}>
          {item}
        </div>
      ))}
    </div>
  );
}

const row = (key: string) =>
  document.querySelector<HTMLElement>(`[data-row-fold="${key}"]`);
const drawn = () =>
  [...document.querySelectorAll<HTMLElement>("[data-row-fold]")].map(
    (el) => el.dataset.rowFold,
  );
const rowAnimations = () => animations.filter((a) => a.keyframes.length > 0);
const clock = () => animations.find((a) => a.keyframes.length === 0)!;

const collapsed = ["a", "b"];
const expanded = ["a", "a1", "a2", "b"];

describe("useRowFold", () => {
  it("draws the first rows as they are", () => {
    render(<List items={expanded} openKeys={new Set(["a"])} />);
    expect(drawn()).toEqual(expanded);
    expect(frames.size).toBe(0);
    expect(animations).toHaveLength(0);
  });

  it("folds revealed rows in: pinned at the first frame, tweened from the next", () => {
    const { rerender } = render(
      <List items={collapsed} openKeys={new Set()} />,
    );
    rerender(<List items={expanded} openKeys={new Set(["a"])} />);
    // The commit: revealed rows clipped shut, the row below held where it was.
    expect(row("a1")!.style.clipPath).toBe("inset(0px 0px 20px 0px)");
    expect(row("a1")!.style.opacity).toBe("0");
    expect(row("a2")!.style.clipPath).toBe("inset(0px 0px 40px 0px)");
    expect(row("b")!.style.transform).toBe("translateY(-40px)");
    expect(row("a")!.style.transform).toBe("");
    expect(animations).toHaveLength(0);

    nextFrame();
    // The pin is released to the tween.
    expect(row("b")!.style.transform).toBe("");
    const byKey = new Map(
      rowAnimations().map((a) => [(a.el as HTMLElement).dataset.rowFold, a]),
    );
    expect([...byKey.keys()]).toEqual(["a1", "a2", "b"]);
    expect(byKey.get("a2")!.keyframes).toEqual([
      {
        transform: "translateY(0px)",
        clipPath: "inset(0px 0px 40px 0px)",
        opacity: 0,
      },
      {
        transform: "translateY(0px)",
        clipPath: "inset(0px 0px 0px 0px)",
        opacity: 1,
      },
    ]);
    expect(byKey.get("b")!.keyframes).toEqual([
      { transform: "translateY(-40px)" },
      { transform: "translateY(0px)" },
    ]);
    expect(clock().startTime).not.toBeNull();
    act(() => clock().onfinish!());
    expect(rowAnimations().every((a) => a.cancelled)).toBe(true);
  });

  it("keeps hidden rows drawn and inert until they have folded away", () => {
    const { rerender } = render(
      <List items={expanded} openKeys={new Set(["a"])} />,
    );
    rerender(<List items={collapsed} openKeys={new Set()} />);
    expect(drawn()).toEqual(expanded);
    expect(row("a1")!.hasAttribute("inert")).toBe(true);
    expect(row("b")!.hasAttribute("inert")).toBe(false);

    nextFrame();
    const b = rowAnimations().find((a) => a.el === row("b"))!;
    expect(b.keyframes).toEqual([
      { transform: "translateY(0px)" },
      { transform: "translateY(-40px)" },
    ]);
    act(() => clock().onfinish!());
    expect(drawn()).toEqual(collapsed);
    expect(b.cancelled).toBe(true);
  });

  it("folds a lazy node's children in when they replace its placeholder", () => {
    const { rerender } = render(
      <List items={collapsed} openKeys={new Set()} />,
    );
    rerender(
      <List items={["a", "a:loading", "b"]} openKeys={new Set(["a"])} />,
    );
    nextFrame();
    act(() => clock().onfinish!());
    animations = [];

    // The listing lands: no flip, but it is the toggle's reveal arriving.
    rerender(<List items={expanded} openKeys={new Set(["a"])} />);
    expect(drawn()).toEqual(["a", "a:loading", "a1", "a2", "b"]);
    expect(row("a:loading")!.hasAttribute("inert")).toBe(true);
    nextFrame();
    const folding = rowAnimations().map(
      (a) => (a.el as HTMLElement).dataset.rowFold,
    );
    expect(folding).toEqual(["a:loading", "a1", "a2", "b"]);
    act(() => clock().onfinish!());
    expect(drawn()).toEqual(expanded);

    // A later live change is live data again.
    animations = [];
    rerender(
      <List items={["a", "a1", "a2", "a3", "b"]} openKeys={new Set(["a"])} />,
    );
    expect(frames.size).toBe(0);
  });

  it("folds rows in that land after a toggle that revealed nothing yet", () => {
    const { rerender } = render(
      <List items={["g", "h"]} openKeys={new Set()} />,
    );
    // The toggle: open, but its rows are still on their way.
    rerender(<List items={["g", "h"]} openKeys={new Set(["g"])} />);
    expect(frames.size).toBe(0);
    rerender(<List items={["g", "g1", "h"]} openKeys={new Set(["g"])} />);
    nextFrame();
    expect(
      rowAnimations().map((a) => (a.el as HTMLElement).dataset.rowFold),
    ).toEqual(["g1", "h"]);
  });

  it("does not fold rows landing after a toggle that revealed real rows", () => {
    const { rerender } = render(
      <List items={["g", "h"]} openKeys={new Set()} />,
    );
    rerender(<List items={["g", "g1", "h"]} openKeys={new Set(["g"])} />);
    nextFrame();
    act(() => clock().onfinish!());
    animations = [];
    rerender(<List items={["g", "g0", "g1", "h"]} openKeys={new Set(["g"])} />);
    expect(frames.size).toBe(0);
  });

  it("draws a change with no disclosure as it lands", () => {
    const { rerender } = render(
      <List items={collapsed} openKeys={new Set(["a"])} />,
    );
    rerender(<List items={["a", "x", "b"]} openKeys={new Set(["a"])} />);
    rerender(<List items={["a", "b"]} openKeys={new Set(["a"])} />);
    expect(drawn()).toEqual(collapsed);
    expect(frames.size).toBe(0);
    expect(animations).toHaveLength(0);
  });

  it("does not fold a list that declares no disclosures", () => {
    const { rerender } = render(
      <List items={collapsed} openKeys={undefined} />,
    );
    rerender(<List items={expanded} openKeys={undefined} />);
    expect(frames.size).toBe(0);
  });

  it("folds nothing under reduced motion", () => {
    vi.spyOn(window, "matchMedia").mockImplementation(
      (query) => ({ matches: true, media: query }) as MediaQueryList,
    );
    const { rerender } = render(
      <List items={expanded} openKeys={new Set(["a"])} />,
    );
    rerender(<List items={collapsed} openKeys={new Set()} />);
    expect(drawn()).toEqual(collapsed);
    expect(frames.size).toBe(0);
  });
});
