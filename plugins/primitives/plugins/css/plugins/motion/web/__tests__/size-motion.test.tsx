/**
 * `useSizeMotion` never resizes the element it observes from inside its own
 * size report: changing an observed element's size during ResizeObserver
 * delivery is what raises "ResizeObserver loop completed with undelivered
 * notifications" (751+ crash reports from toasts growing / shrinking). The
 * tween starts where the content changes — the MutationObserver, which runs
 * after the commit and before the frame's layout — and the size report only
 * records the resting box.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { useRef, type ReactElement } from "react";
import { useSizeMotion } from "../internal/size-motion";

/** A ResizeObserver the test drives: `resize(el)` reports `el` to whoever watches it. */
class DrivenResizeObserver {
  static all = new Set<DrivenResizeObserver>();
  watched = new Set<Element>();
  constructor(private cb: ResizeObserverCallback) {
    DrivenResizeObserver.all.add(this);
  }
  observe(el: Element): void {
    this.watched.add(el);
  }
  unobserve(el: Element): void {
    this.watched.delete(el);
  }
  disconnect(): void {
    this.watched.clear();
    DrivenResizeObserver.all.delete(this);
  }
  static resize(el: Element): void {
    for (const ro of DrivenResizeObserver.all) {
      if (!ro.watched.has(el)) continue;
      ro.cb(
        [{ target: el } as ResizeObserverEntry],
        ro as unknown as ResizeObserver,
      );
    }
  }
}

/** The laid-out box every `offsetWidth` / `offsetHeight` read answers. */
let box = { w: 300, h: 80 };
let animate: ReturnType<typeof vi.fn>;

function Probe({ lines }: { lines: number }): ReactElement {
  const ref = useRef<HTMLDivElement>(null);
  useSizeMotion(ref, true);
  return (
    <div ref={ref} data-testid="surface">
      {Array.from({ length: lines }, (_, i) => (
        <p key={i}>line {i}</p>
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

beforeEach(() => {
  box = { w: 300, h: 80 };
  vi.stubGlobal("ResizeObserver", DrivenResizeObserver);
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({ matches: false }) as unknown as MediaQueryList),
  );
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(
    () => box.w,
  );
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(
    () => box.h,
  );
  animate = vi.fn(() => ({ onfinish: null, cancel: () => {} }));
  Object.assign(HTMLElement.prototype, {
    animate,
    getAnimations: () => [],
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  DrivenResizeObserver.all.clear();
});

describe("useSizeMotion", () => {
  it("tweens a content change from the mutation, before any size report", async () => {
    const { rerender, getByTestId } = render(<Probe lines={1} />);
    box = { w: 300, h: 120 };
    rerender(<Probe lines={2} />);
    await flushMutations();
    expect(animate).toHaveBeenCalledTimes(1);
    const [keyframes] = animate.mock.calls[0] as [Keyframe[]];
    expect(keyframes[0]!.height).toBe("80px");
    expect(keyframes[1]!.height).toBe("120px");

    // The frame's size report then changes nothing: no second tween.
    DrivenResizeObserver.resize(getByTestId("surface"));
    expect(animate).toHaveBeenCalledTimes(1);
  });

  it("never animates from inside a size report", async () => {
    const { rerender, getByTestId } = render(<Probe lines={1} />);
    // A content change whose size lands only on a later report (an image
    // decoding) — the report records it, it does not resize the element.
    rerender(<Probe lines={2} />);
    await flushMutations();
    box = { w: 300, h: 160 };
    DrivenResizeObserver.resize(getByTestId("surface"));
    expect(animate).not.toHaveBeenCalled();

    // The recorded box is the next tween's start.
    box = { w: 300, h: 200 };
    rerender(<Probe lines={3} />);
    await flushMutations();
    const [keyframes] = animate.mock.calls[0] as [Keyframe[]];
    expect(keyframes[0]!.height).toBe("160px");
    expect(keyframes[1]!.height).toBe("200px");
  });

  it("lands a resize with no content change at once", () => {
    const { getByTestId } = render(<Probe lines={1} />);
    box = { w: 500, h: 80 };
    DrivenResizeObserver.resize(getByTestId("surface"));
    expect(animate).not.toHaveBeenCalled();
  });
});
