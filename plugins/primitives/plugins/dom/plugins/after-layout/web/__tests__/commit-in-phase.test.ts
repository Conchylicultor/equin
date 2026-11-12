import { afterEach, describe, expect, it, vi } from "vitest";

import {
  commitInPhase,
  observeInPhase,
  runAsAfterLayout,
} from "../internal/after-layout";

function fakeObserver(): { observer: ResizeObserver; observed: Set<Element> } {
  const observed = new Set<Element>();
  const observer = {
    observe: (el: Element) => observed.add(el),
    unobserve: (el: Element) => observed.delete(el),
    disconnect: () => observed.clear(),
  } as unknown as ResizeObserver;
  return { observer, observed };
}

/** body > shallow ; body > a > b > deep > deeper — each with a settable
 * layout width (jsdom has no layout). */
function tree(): {
  shallow: Element;
  deep: Element;
  deeper: Element;
  widths: Map<Element, number>;
} {
  document.body.innerHTML =
    '<div id="shallow"></div><div><div><div id="deep"><div id="deeper"></div></div></div></div>';
  const get = (id: string) => document.getElementById(id) as Element;
  const widths = new Map<Element, number>();
  for (const el of [get("shallow"), get("deep"), get("deeper")]) {
    widths.set(el, 100);
    el.getBoundingClientRect = () =>
      ({ width: widths.get(el) ?? 0, height: 10 }) as DOMRect;
  }
  return {
    shallow: get("shallow"),
    deep: get("deep"),
    deeper: get("deeper"),
    widths,
  };
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

describe("commitInPhase", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("answers in the phase a resize its commit made above the delivery, and restarts the observation next frame", () => {
    const { shallow, deep, widths } = tree();
    const frames = stubFrames();
    const { observer, observed } = fakeObserver();
    const heldBack = vi.fn();
    const release = observeInPhase(observer, shallow, heldBack);
    expect(observed.has(shallow)).toBe(true);

    runAsAfterLayout(
      () => commitInPhase(() => widths.set(shallow, 50)),
      [deep],
    );

    // Nothing left for the browser to hold back, and answered before paint.
    expect(observed.has(shallow)).toBe(false);
    expect(heldBack).toHaveBeenCalledTimes(1);
    for (const cb of frames) cb(0);
    expect(observed.has(shallow)).toBe(true);
    release();
  });

  it("settles the resizes an answer's own commit makes", () => {
    const { shallow, deep, widths } = tree();
    stubFrames();
    const { observer } = fakeObserver();
    // The delivered box itself is at the delivery's depth: held back too.
    const deepHeld = vi.fn(() => commitInPhase(() => widths.set(shallow, 40)));
    const shallowHeld = vi.fn();
    const releaseDeep = observeInPhase(observer, deep, deepHeld);
    const releaseShallow = observeInPhase(observer, shallow, shallowHeld);

    runAsAfterLayout(() => commitInPhase(() => widths.set(deep, 60)), [deep]);

    expect(deepHeld).toHaveBeenCalledTimes(1);
    expect(shallowHeld).toHaveBeenCalledTimes(1);
    releaseDeep();
    releaseShallow();
  });

  it("leaves to the browser what it can still deliver: resizes below the delivery", () => {
    const { deep, deeper, widths } = tree();
    stubFrames();
    const { observer, observed } = fakeObserver();
    const heldBack = vi.fn();
    const release = observeInPhase(observer, deeper, heldBack);

    runAsAfterLayout(() => commitInPhase(() => widths.set(deeper, 10)), [deep]);

    expect(heldBack).not.toHaveBeenCalled();
    expect(observed.has(deeper)).toBe(true);
    release();
  });

  it("an unchanged box, or a released observation, is not answered", () => {
    const { shallow, deep, widths } = tree();
    stubFrames();
    const { observer } = fakeObserver();
    const heldBack = vi.fn();
    const release = observeInPhase(observer, shallow, heldBack);

    runAsAfterLayout(() => commitInPhase(() => {}), [deep]);
    expect(heldBack).not.toHaveBeenCalled();

    runAsAfterLayout(
      () =>
        commitInPhase(() => {
          widths.set(shallow, 1);
          release();
        }),
      [deep],
    );
    expect(heldBack).not.toHaveBeenCalled();
  });

  it("throws on an answer that keeps resizing what it observes", () => {
    const { shallow, deep, widths } = tree();
    stubFrames();
    const { observer } = fakeObserver();
    const release = observeInPhase(observer, shallow, () =>
      commitInPhase(() => widths.set(shallow, (widths.get(shallow) ?? 0) + 1)),
    );
    expect(() =>
      runAsAfterLayout(
        () => commitInPhase(() => widths.set(shallow, 0)),
        [deep],
      ),
    ).toThrow(/still resizing observed elements/);
    release();
  });
});
