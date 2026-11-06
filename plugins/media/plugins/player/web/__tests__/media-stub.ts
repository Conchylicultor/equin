import { vi } from "vitest";

/**
 * A playable HTMLMediaElement for jsdom, which implements none of playback:
 * play / pause flip `paused` and fire their events, `currentTime`, `volume`
 * and `muted` are plain state that fire `timeupdate` / `volumechange`, and
 * every clip is `DURATION` seconds long.
 */
export const DURATION = 60;

interface State {
  paused: boolean;
  currentTime: number;
  volume: number;
  muted: boolean;
}

const states = new WeakMap<HTMLMediaElement, State>();

function stateOf(el: HTMLMediaElement): State {
  let s = states.get(el);
  if (!s) {
    s = { paused: true, currentTime: 0, volume: 1, muted: false };
    states.set(el, s);
  }
  return s;
}

export function installMediaStub() {
  const proto = HTMLMediaElement.prototype;
  const play = vi.fn(function (this: HTMLMediaElement) {
    stateOf(this).paused = false;
    this.dispatchEvent(new Event("play"));
    return Promise.resolve();
  });
  const pause = vi.fn(function (this: HTMLMediaElement) {
    stateOf(this).paused = true;
    this.dispatchEvent(new Event("pause"));
  });
  Object.defineProperty(proto, "play", { configurable: true, value: play });
  Object.defineProperty(proto, "pause", { configurable: true, value: pause });
  Object.defineProperty(proto, "load", {
    configurable: true,
    value: () => undefined,
  });
  Object.defineProperty(proto, "paused", {
    configurable: true,
    get(this: HTMLMediaElement) {
      return stateOf(this).paused;
    },
  });
  Object.defineProperty(proto, "duration", {
    configurable: true,
    get: () => DURATION,
  });
  Object.defineProperty(proto, "buffered", {
    configurable: true,
    get: () => ({ length: 0, start: () => 0, end: () => 0 }),
  });
  for (const [name, event] of [
    ["currentTime", "timeupdate"],
    ["volume", "volumechange"],
    ["muted", "volumechange"],
  ] as const) {
    Object.defineProperty(proto, name, {
      configurable: true,
      get(this: HTMLMediaElement) {
        return stateOf(this)[name];
      },
      set(this: HTMLMediaElement, v: never) {
        stateOf(this)[name] = v;
        this.dispatchEvent(new Event(event));
      },
    });
  }
  // jsdom has no pointer capture and no PointerEvent.
  Element.prototype.setPointerCapture = () => undefined;
  Element.prototype.releasePointerCapture = () => undefined;
  if (!("PointerEvent" in window)) {
    class PointerEventPolyfill extends MouseEvent {
      pointerId: number;
      constructor(type: string, init: PointerEventInit = {}) {
        super(type, init);
        this.pointerId = init.pointerId ?? 1;
      }
    }
    Object.defineProperty(window, "PointerEvent", {
      configurable: true,
      value: PointerEventPolyfill,
    });
  }
  return { play, pause };
}

/** A box for `getBoundingClientRect`: `left`, `width` (and a 20px height). */
export function stubRect(el: Element, left: number, width: number) {
  el.getBoundingClientRect = () =>
    ({
      left,
      width,
      right: left + width,
      top: 0,
      bottom: 20,
      height: 20,
      x: left,
      y: 0,
      toJSON: () => ({}),
    }) as DOMRect;
}
