import { afterEach, describe, expect, it, vi } from "vitest";

import { observeInPhase, runAsAfterLayout } from "../internal/after-layout";

function fakeObserver(): { observer: ResizeObserver; observed: Element[] } {
  const observed: Element[] = [];
  const observer = {
    observe: (el: Element) => observed.push(el),
    unobserve: () => {},
    disconnect: () => {},
  } as unknown as ResizeObserver;
  return { observer, observed };
}

/** body > shallow ; body > a > b > deep */
function tree(): { shallow: Element; deep: Element; deeper: Element } {
  document.body.innerHTML =
    '<div id="shallow"></div><div><div><div id="deep"><div id="deeper"></div></div></div></div>';
  const get = (id: string) => document.getElementById(id) as Element;
  return { shallow: get("shallow"), deep: get("deep"), deeper: get("deeper") };
}

describe("observeInPhase", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("observes at once outside a phase", () => {
    const { shallow } = tree();
    const { observer, observed } = fakeObserver();
    observeInPhase(observer, shallow);
    expect(observed).toEqual([shallow]);
  });

  it("observes at once a target deeper than the running delivery", () => {
    const { deep, deeper } = tree();
    const { observer, observed } = fakeObserver();
    runAsAfterLayout(() => observeInPhase(observer, deeper), [deep]);
    expect(observed).toEqual([deeper]);
  });

  it("defers to the next frame a target the running delivery can no longer deliver", () => {
    const { shallow, deep } = tree();
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      frames.push(cb);
      return frames.length;
    });
    const { observer, observed } = fakeObserver();
    // The same depth as the delivery is held back too, not only shallower.
    runAsAfterLayout(() => {
      observeInPhase(observer, shallow);
      observeInPhase(observer, deep);
    }, [deep]);
    expect(observed).toEqual([]);
    for (const cb of frames) cb(0);
    expect(observed).toEqual([shallow, deep]);
  });

  it("a cancelled deferred observation never starts", () => {
    const { shallow, deep } = tree();
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      frames.push(cb);
      return frames.length;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});
    const { observer, observed } = fakeObserver();
    let cancel = (): void => {};
    runAsAfterLayout(() => {
      cancel = observeInPhase(observer, shallow);
    }, [deep]);
    cancel();
    for (const cb of frames) cb(0);
    expect(observed).toEqual([]);
  });
});
