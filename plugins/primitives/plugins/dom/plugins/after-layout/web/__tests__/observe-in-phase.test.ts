import { afterEach, describe, expect, it, vi } from "vitest";

import {
  installDeliveryWatch,
  observeInPhase,
  runAsAfterLayout,
} from "../internal/after-layout";

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

  it("a library observer's delivery bounds what starts in it, until the step ends", async () => {
    const { shallow, deep, deeper } = tree();
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      frames.push(cb);
      return frames.length;
    });
    // A drivable native observer: the test delivers its callback by hand.
    const callbacks: ResizeObserverCallback[] = [];
    class DrivableObserver {
      constructor(cb: ResizeObserverCallback) {
        callbacks.push(cb);
      }
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
    vi.stubGlobal("cancelAnimationFrame", () => {});
    vi.stubGlobal("ResizeObserver", DrivableObserver);
    const uninstall = installDeliveryWatch();
    try {
      // A library's observer (floating-ui's autoUpdate) — never wrapped in
      // runAsAfterLayout — whose commit runs in a microtask of its callback.
      const library = new ResizeObserver(() => {
        void Promise.resolve().then(() => {
          observeInPhase(own.observer, shallow);
          observeInPhase(own.observer, deeper);
        });
      });
      const own = fakeObserver();
      callbacks[0]!(
        [{ target: deep } as unknown as ResizeObserverEntry],
        library,
      );
      await Promise.resolve();
      // The deeper target can still be delivered this step; the shallow one
      // would be held back into a loop, so it starts at the next frame —
      // whose first callback has closed the delivery.
      expect(own.observed).toEqual([deeper]);
      for (const cb of frames) cb(0);
      expect(own.observed).toEqual([deeper, shallow]);
      expect(frames).toHaveLength(2);

      // Once the step has ended, an observation starts at once again.
      await new Promise((resolve) => setTimeout(resolve, 0));
      const later = fakeObserver();
      observeInPhase(later.observer, shallow);
      expect(later.observed).toEqual([shallow]);
    } finally {
      uninstall();
    }
  });
});
