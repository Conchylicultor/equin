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

/** An element's layout width, as its inline style: jsdom has no layout, and
 * its computed style resolves the inline one — what after-layout reads. */
interface Widths {
  set(el: Element, px: number): void;
  get(el: Element): number;
}

const widths: Widths = {
  set: (el, px) => {
    (el as HTMLElement).style.width = `${px}px`;
  },
  get: (el) => parseFloat((el as HTMLElement).style.width),
};

/** body > shallow ; body > a > b > deep > deeper — each with a settable
 * layout width. */
function tree(): {
  shallow: Element;
  deep: Element;
  deeper: Element;
  widths: Widths;
} {
  document.body.innerHTML =
    '<div id="shallow"></div><div><div><div id="deep"><div id="deeper"></div></div></div></div>';
  const get = (id: string) => document.getElementById(id) as HTMLElement;
  for (const el of [get("shallow"), get("deep"), get("deeper")]) {
    widths.set(el, 100);
    el.style.height = "10px";
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

  it("answers an observed element the commit detaches, at any depth: the browser could only hold its 0×0 back", () => {
    const { deep, deeper } = tree();
    const frames = stubFrames();
    const { observer, observed } = fakeObserver();
    const heldBack = vi.fn();
    // A component keeps observing an element React replaced (virtual-rows'
    // boxes above its list, when the DataView toolbar remounts).
    const release = observeInPhase(observer, deeper, heldBack);

    runAsAfterLayout(() => commitInPhase(() => deeper.remove()), [deep]);

    expect(heldBack).toHaveBeenCalledTimes(1);
    expect(observed.has(deeper)).toBe(false);
    for (const cb of frames) cb(0);
    expect(observed.has(deeper)).toBe(true);
    // Already detached at the next phase: not answered again.
    runAsAfterLayout(() => commitInPhase(() => {}), [deep]);
    expect(heldBack).toHaveBeenCalledTimes(1);
    release();
  });

  it("a box that only moved under a transform is not a resize", () => {
    const { shallow, deep } = tree();
    stubFrames();
    const { observer } = fakeObserver();
    const heldBack = vi.fn();
    const release = observeInPhase(observer, shallow, heldBack);
    // The rendered rect jitters with the box's position under a scale (float
    // math); its layout size does not, and that is what a ResizeObserver sees.
    let jitter = 30;
    shallow.getBoundingClientRect = () =>
      ({ width: 864, height: (jitter += 1e-5) }) as DOMRect;

    runAsAfterLayout(
      () => commitInPhase(() => shallow.setAttribute("data-moved", "")),
      [deep],
    );

    expect(heldBack).not.toHaveBeenCalled();
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

  it("names the observation that kept resizing, and stops within ten passes", () => {
    const { shallow, deep, widths } = tree();
    shallow.setAttribute("data-source", "plugins/x/web/oscillator.tsx:12");
    stubFrames();
    const { observer } = fakeObserver();
    let answers = 0;
    // A two-state oscillation: each answer flips the width back.
    const release = observeInPhase(observer, shallow, () => {
      answers++;
      commitInPhase(() =>
        widths.set(shallow, widths.get(shallow) === 100 ? 85 : 100),
      );
    });
    expect(() =>
      runAsAfterLayout(
        () => commitInPhase(() => widths.set(shallow, 85)),
        [deep],
      ),
    ).toThrow(
      /after 10 passes in one frame: oscillator\.tsx:12 100×10→85×10→100×10 — /,
    );
    expect(answers).toBe(10);
    release();
  });
});
