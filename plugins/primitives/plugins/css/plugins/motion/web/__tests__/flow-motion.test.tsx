/**
 * `useFlowMotion`: when the set of a container's laid-out children changes, a
 * new child enters and the ones it displaced glide from their old place — seen
 * through `display: contents` wrappers, and blind to changes deeper inside an
 * item.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { useRef, type CSSProperties, type ReactElement } from "react";
import { useFlowMotion } from "../internal/flow-motion";

/** Every item is a 40px-tall row; its top is its index among the items. */
const ROW = 40;

class InertResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

let animate: ReturnType<typeof vi.fn>;

const CONTAINER_STYLE = {
  "--overlay-enter-duration": "140ms",
  "--overlay-enter-scale": "0.96",
} as CSSProperties;

function Probe({
  keys,
  text = "",
}: {
  keys: readonly string[];
  text?: string;
}): ReactElement {
  const ref = useRef<HTMLDivElement>(null);
  useFlowMotion(ref, true);
  return (
    <div ref={ref} data-testid="flow" style={CONTAINER_STYLE}>
      {keys.map((k) => (
        // A render slot's layout-neutral item box.
        <div key={k} style={{ display: "contents" }}>
          <section data-item={k}>
            {k}
            <span>{text}</span>
          </section>
        </div>
      ))}
    </div>
  );
}

/** Let the MutationObserver's microtask run. */
async function flushMutations(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

function rectAt(top: number): DOMRect {
  return {
    left: 0,
    top,
    width: 100,
    height: ROW,
    right: 100,
    bottom: top + ROW,
    x: 0,
    y: top,
    toJSON: () => ({}),
  };
}

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", InertResizeObserver);
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({ matches: false }) as unknown as MediaQueryList),
  );
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(100);
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(ROW);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      if (!this.dataset.item) return rectAt(0);
      const all = Array.from(document.querySelectorAll("[data-item]"));
      return rectAt(all.indexOf(this) * ROW);
    },
  );
  animate = vi.fn(() => ({ onfinish: null, cancel: () => {} }));
  Object.assign(HTMLElement.prototype, { animate });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** The calls `animate` got, by the item they ran on. */
function callsOn(key: string): Keyframe[][] {
  return animate.mock.contexts.flatMap((ctx, i) =>
    (ctx as HTMLElement).dataset.item === key
      ? [animate.mock.calls[i]![0] as Keyframe[]]
      : [],
  );
}

describe("useFlowMotion", () => {
  it("moves nothing on the first render", async () => {
    render(<Probe keys={["a", "b"]} />);
    await flushMutations();
    expect(animate).not.toHaveBeenCalled();
  });

  it("fades a shown item in and glides the ones it pushed down", async () => {
    const { rerender } = render(<Probe keys={["a", "c"]} />);
    rerender(<Probe keys={["a", "b", "c"]} />);
    await flushMutations();

    expect(callsOn("a")).toEqual([]);
    const [enter] = callsOn("b");
    expect(enter![0]).toMatchObject({ opacity: 0, scale: "0.96" });
    const [glide] = callsOn("c");
    // c was drawn one row up: it starts there and slides down to its place.
    expect(glide![0]).toEqual({ translate: `0px ${-ROW}px` });
    expect(glide![1]).toEqual({ translate: "0px 0px" });
  });

  it("glides the rest up into a removed item's place", async () => {
    const { rerender } = render(<Probe keys={["a", "b", "c"]} />);
    rerender(<Probe keys={["a", "c"]} />);
    await flushMutations();
    const [glide] = callsOn("c");
    expect(glide![0]).toEqual({ translate: `0px ${ROW}px` });
  });

  it("ignores a change inside an item", async () => {
    const { rerender } = render(<Probe keys={["a", "b"]} text="x" />);
    rerender(<Probe keys={["a", "b"]} text="y" />);
    rerender(<Probe keys={["a", "b"]} />);
    await flushMutations();
    expect(animate).not.toHaveBeenCalled();
  });

  it("moves nothing under reduced motion", async () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: true }) as unknown as MediaQueryList),
    );
    const { rerender } = render(<Probe keys={["a", "c"]} />);
    rerender(<Probe keys={["a", "b", "c"]} />);
    await flushMutations();
    expect(animate).not.toHaveBeenCalled();
  });
});
