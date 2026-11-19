import { afterEach, describe, expect, it, vi } from "vitest";

import {
  commitInPhase,
  installDeliveryWatch,
  runAsAfterLayout,
} from "../internal/after-layout";

/** What the browser's own observer was asked to do, in order. */
type NativeCall = ["observe" | "unobserve", Element, unknown?];

/** A stand-in for the browser's `ResizeObserver`, recording every call that
 * reaches it — past the delivery watch's overrides. */
function nativeObserverClass(calls: NativeCall[]) {
  return class NativeObserver {
    constructor(_cb: ResizeObserverCallback) {}
    observe(el: Element, options?: unknown): void {
      calls.push(["observe", el, options]);
    }
    unobserve(el: Element): void {
      calls.push(["unobserve", el]);
    }
    disconnect(): void {}
  };
}

/** body > shallow ; body > a > b > deep — each with a settable layout width,
 * as its inline style: jsdom has no layout, and its computed style resolves
 * the inline one — what after-layout reads. */
function tree(): {
  shallow: Element;
  deep: Element;
  widths: { set(el: Element, px: number): void };
} {
  document.body.innerHTML =
    '<div id="shallow"></div><div><div><div id="deep"></div></div></div>';
  const get = (id: string) => document.getElementById(id) as HTMLElement;
  const widths = {
    set: (el: Element, px: number) => {
      (el as HTMLElement).style.width = `${px}px`;
    },
  };
  for (const el of [get("shallow"), get("deep")]) {
    widths.set(el, 100);
    el.style.height = "10px";
  }
  return { shallow: get("shallow"), deep: get("deep"), widths };
}

function stubFrames(): FrameRequestCallback[] {
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    frames.push(cb);
    return frames.length;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {});
  return frames;
}

/** Install the delivery watch over a recording native observer; returns the
 * recorded calls and the uninstall. */
function watched(): { calls: NativeCall[]; uninstall: () => void } {
  const calls: NativeCall[] = [];
  vi.stubGlobal("ResizeObserver", nativeObserverClass(calls));
  return { calls, uninstall: installDeliveryWatch() };
}

// A library (floating-ui's `autoUpdate`, in every popup) creates and observes
// with the page's `ResizeObserver` directly: the delivery watch keeps its
// observations as the app's own, so the browser never holds one back.
describe("a library observer under the delivery watch", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("observes at once outside a phase, with its options", () => {
    const { shallow } = tree();
    const { calls, uninstall } = watched();
    try {
      const library = new ResizeObserver(() => {});
      library.observe(shallow, { box: "border-box" });
      expect(calls).toEqual([["observe", shallow, { box: "border-box" }]]);
      library.disconnect();
    } finally {
      uninstall();
    }
  });

  it("is restarted at the next frame, not held back, when a commit inside a deeper delivery resizes its target", () => {
    const { shallow, deep, widths } = tree();
    const frames = stubFrames();
    const { calls, uninstall } = watched();
    try {
      // A popup observed before the phase; the phase's commit changes its
      // content (its size).
      const library = new ResizeObserver(() => {});
      library.observe(shallow);
      calls.length = 0;

      runAsAfterLayout(
        () => commitInPhase(() => widths.set(shallow, 50)),
        [deep],
      );

      expect(calls).toEqual([["unobserve", shallow]]);
      for (const cb of frames) cb(0);
      expect(calls).toEqual([
        ["unobserve", shallow],
        ["observe", shallow, undefined],
      ]);
      library.disconnect();
    } finally {
      uninstall();
    }
  });

  it("starts a target the running delivery can no longer deliver at the next frame", () => {
    const { shallow, deep } = tree();
    const frames = stubFrames();
    const { calls, uninstall } = watched();
    try {
      // A popup mounted by a commit inside a deep delivery.
      const library = new ResizeObserver(() => {});
      runAsAfterLayout(() => library.observe(shallow), [deep]);
      expect(calls).toEqual([]);
      for (const cb of frames) cb(0);
      expect(calls).toEqual([["observe", shallow, undefined]]);
      library.disconnect();
    } finally {
      uninstall();
    }
  });

  it("an unobserve or a disconnect releases it: no pending start, no settle", () => {
    const { shallow, deep, widths } = tree();
    const frames = stubFrames();
    const { calls, uninstall } = watched();
    try {
      const pending = new ResizeObserver(() => {});
      runAsAfterLayout(() => pending.observe(shallow), [deep]);
      pending.disconnect();
      for (const cb of frames.splice(0)) cb(0);
      expect(calls).toEqual([]);

      const released = new ResizeObserver(() => {});
      released.observe(shallow);
      released.unobserve(shallow);
      calls.length = 0;
      runAsAfterLayout(
        () => commitInPhase(() => widths.set(shallow, 20)),
        [deep],
      );
      expect(calls).toEqual([]);
      expect(frames).toEqual([]);
    } finally {
      uninstall();
    }
  });
});
