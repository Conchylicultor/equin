/**
 * A `useResizeObserver` target may name DOM its caller does not own (the
 * boxes before a region, a scroller's children), which changes without the
 * caller's `deps` changing. The observed set follows it: an element replaced,
 * inserted or removed at an observed element's level is re-resolved through
 * the target, and `onResize` runs when the set moved.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import type { ReactElement } from "react";
import { useRef } from "react";
import { useResizeObserver } from "../internal/element-size";

/** A ResizeObserver the test reads: which elements are watched now. */
class WatchingResizeObserver {
  static all = new Set<WatchingResizeObserver>();
  watched = new Set<Element>();
  constructor(_cb: ResizeObserverCallback) {
    WatchingResizeObserver.all.add(this);
  }
  observe(el: Element): void {
    this.watched.add(el);
  }
  unobserve(el: Element): void {
    this.watched.delete(el);
  }
  disconnect(): void {
    this.watched.clear();
    WatchingResizeObserver.all.delete(this);
  }
  static watching(): Element[] {
    return [...WatchingResizeObserver.all].flatMap((ro) => [...ro.watched]);
  }
}

let calls = 0;

afterEach(() => {
  vi.unstubAllGlobals();
  WatchingResizeObserver.all.clear();
  cleanup();
  calls = 0;
});

describe("useResizeObserver — the observed set follows the DOM", () => {
  it("swaps a replaced child for its replacement and runs onResize", async () => {
    vi.stubGlobal("ResizeObserver", WatchingResizeObserver);
    function Seeded(): ReactElement {
      const list = useRef<HTMLDivElement>(null);
      useResizeObserver(
        () => (list.current ? [...list.current.children] : null),
        () => {
          calls++;
        },
      );
      return (
        <div ref={list}>
          <div data-testid="a" />
        </div>
      );
    }
    const { getByTestId } = render(<Seeded />);
    const a = getByTestId("a");
    expect(WatchingResizeObserver.watching()).toEqual([a]);
    expect(calls).toBe(1);

    // A box inserted beside the observed one.
    const b = document.createElement("div");
    a.after(b);
    await act(async () => {});
    expect(WatchingResizeObserver.watching()).toEqual([a, b]);
    expect(calls).toBe(2);

    // The observed one replaced: the detached element is no longer watched.
    const c = document.createElement("div");
    a.replaceWith(c);
    await act(async () => {});
    expect(WatchingResizeObserver.watching()).toEqual([b, c]);
    expect(calls).toBe(3);

    // A mutation that leaves the set as it was runs nothing.
    b.append(document.createElement("span"));
    await act(async () => {});
    expect(calls).toBe(3);
  });
});
