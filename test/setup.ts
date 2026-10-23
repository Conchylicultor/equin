// Shared vitest setup: pin the clock, assert the pinned locale and timezone, and
// stub browser APIs missing from jsdom (loaded by every DOM suite via the root
// vitest.config.ts `setupFiles`).

import { afterEach, beforeEach, vi } from "vitest";

// The locale and timezone are pinned by `vitest.config.ts` (`test.env`), not
// here: a process reads its default locale once, when it starts, and nothing
// this file does can change it. What this file CAN do is refuse to run on a
// worker the pin did not reach — a `threads` pool, where `test.env` lands in
// `process.env` after the locale was already fixed, or a runner started some
// other way — so a locale-dependent failure never gets as far as looking like a
// real one. It compares what ICU resolved against what the config asked for,
// so the values live in the config alone (their constants are in
// test-layout/core, whose barrel this file cannot load: it needs Bun).
function assertLocalePinned(): void {
  const { LC_ALL: lcAll, TZ: tz } = process.env;
  // `en_US.UTF-8` → `en-US`: drop the encoding, BCP 47 separator.
  const wantLocale = lcAll?.split(".")[0]?.replace("_", "-");
  const got = new Intl.DateTimeFormat().resolvedOptions();
  if (wantLocale && tz && got.locale === wantLocale && got.timeZone === tz)
    return;
  throw new Error(
    `jsdom test worker is not running in the pinned locale and timezone: ` +
      `LC_ALL=${lcAll ?? "(unset)"} TZ=${tz ?? "(unset)"}, but it resolved ` +
      `locale "${got.locale}", timezone "${got.timeZone}". vitest.config.ts pins ` +
      "both through `test.env`, which only reaches a worker vitest starts as its " +
      'own process — keep `pool: "forks"` and the `env` block there.',
  );
}
assertLocalePinned();

// The instant every jsdom test starts at. A test must not be able to depend on
// what day it is run on — the failure mode is a suite that is green for a month
// and red the next, for everyone, with no code change at all. That is not
// hypothetical: the date-editor integration suite rendered a real calendar and
// reasoned about which cell carried which number, an argument that only held
// while "today" stayed outside the month under test.
//
// Only `Date` is faked, and `shouldAdvanceTime` keeps it ticking forward in real
// time. `setTimeout`, `setInterval` and `performance` stay real, so `waitFor`,
// React's scheduling and every genuinely async path behave exactly as before:
// the ORIGIN is pinned, not the flow of time.
//
// The sinon-backed `useFakeTimers` path is deliberate. A bare `vi.setSystemTime`
// with no fake timers installed takes vitest's own date-mock path, which swaps
// `globalThis.Date` for a subclass carrying no `Symbol.hasInstance` — every
// `Date` built before the swap then stops being `instanceof Date`. Sinon's
// `ClockDate` defines that symbol against the native constructor, so dates from
// either side of the install still answer `instanceof` correctly. Trading a time
// bomb for a footgun would not be a fix.
//
// This is a FLOOR, not a value to assert against. A suite whose assertions
// depend on "today" — `aria-current="date"`, the Today/Tomorrow presets — still
// pins its own instant explicitly, the way
// `plugins/primitives/plugins/date-picker/web/__tests__/calendar-grid.test.tsx`
// does; and a file installing its own fake timers overrides this completely,
// since each `vi.useFakeTimers()` uninstalls the clock before it.
const TEST_NOW = new Date(2026, 5, 15, 12, 0, 0); // Monday 15 June 2026, local noon

function pinTestClock(): void {
  vi.useFakeTimers({ toFake: ["Date"], shouldAdvanceTime: true });
  vi.setSystemTime(TEST_NOW);
}

// Once at setup-evaluation time — setup files run BEFORE the test module, so a
// module-scope `new Date()` constant in a suite is pinned too — and again per
// test, to re-assert the pin for a file that hands the clock back in its own
// `afterEach`.
pinTestClock();
beforeEach(pinTestClock);
afterEach(() => {
  vi.useRealTimers();
});

Object.defineProperty(window, "matchMedia", {
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }),
});

HTMLCanvasElement.prototype.getContext = (() => null) as never;

// jsdom ships no ResizeObserver, so any component reaching the `element-size`
// primitive (StickyStack, data-table, Expandable, …) throws on mount. The stub is
// deliberately inert rather than a polyfill: jsdom has no layout engine, so
// `getBoundingClientRect` is all-zero and elements never resize — a polling
// polyfill would observe a 0x0 box forever and fire nothing. `element-size` is
// built for exactly this (see its CLAUDE.md, "Why a synchronous initial measure"):
// the one synchronous measure inside the layout effect is enough to decide layout
// under a no-op observer.
//
// So this supplies the global's *existence* only. A test needing a non-zero size
// stubs the measurement source itself (see `expandable`'s `offsetHeight` fixture);
// a test needing to *drive* resizes installs its own drivable observer with
// `vi.stubGlobal`, which wins over this one.
class InertResizeObserver implements ResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

Object.defineProperty(globalThis, "ResizeObserver", {
  value: InertResizeObserver,
  configurable: true,
  writable: true,
});

// jsdom ships no Web Animations API, so any component reaching an `el.animate`
// tween (the collapsible fold) throws on its first toggle. jsdom has no clock to
// run one against either, so the stub is an animation that has already played:
// `finish` fires on the next microtask, landing the same end state a real
// tween reaches. A test asserting on the tween itself installs its own
// `Element.prototype.animate` (see collapsible's fold-motion test).
Element.prototype.animate = function (): Animation {
  const anim = {
    startTime: null as number | null,
    onfinish: null as ((ev: AnimationPlaybackEvent) => void) | null,
    cancel(): void {
      this.onfinish = null;
    },
  };
  queueMicrotask(() =>
    anim.onfinish?.call(anim as never, {} as AnimationPlaybackEvent),
  );
  return anim as unknown as Animation;
};

// jsdom ships no Web Animations API and runs no CSS transitions, so nothing is
// ever animating: `getAnimations` reports none (a component waiting for its
// transitions to finish — FloatingAction's reveal — settles on the next
// microtask). A test that needs a running animation stubs it on the element.
Element.prototype.getAnimations = function (): Animation[] {
  return [];
};

// jsdom under vitest exposes a non-functional `localStorage` (Node's
// `--localstorage-file` stub). Install a deterministic in-memory Storage so code
// under test that persists to localStorage works and starts each file clean.
class MemoryStorage implements Storage {
  private store = new Map<string, string>();
  get length(): number {
    return this.store.size;
  }
  clear(): void {
    this.store.clear();
  }
  getItem(key: string): string | null {
    return this.store.has(key) ? this.store.get(key)! : null;
  }
  key(index: number): string | null {
    return [...this.store.keys()][index] ?? null;
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
  setItem(key: string, value: string): void {
    this.store.set(key, String(value));
  }
}

const memoryStorage = new MemoryStorage();
Object.defineProperty(window, "localStorage", {
  value: memoryStorage,
  configurable: true,
});
Object.defineProperty(globalThis, "localStorage", {
  value: memoryStorage,
  configurable: true,
});

// jsdom ships neither SharedWorker nor the Web Locks API, both of which the
// shared live-state socket (networking's `SharedWebSocket`) needs: every suite
// mounting a `NotificationsProvider` would throw on construction. Inert, like
// `ResizeObserver` above: the worker never answers, so the socket stays
// "connecting" forever — exactly what jsdom's never-connecting `WebSocket` gave
// these suites before. A suite exercising the transport injects the
// deterministic fakes from `@plugins/primitives/plugins/networking/web/testing`
// instead, which win over these globals.
class InertMessagePort {
  onmessage: ((ev: MessageEvent) => void) | null = null;
  postMessage(): void {}
  close(): void {}
}

class InertSharedWorker {
  readonly port = new InertMessagePort();
  onerror: ((ev: ErrorEvent) => void) | null = null;
}

Object.defineProperty(globalThis, "SharedWorker", {
  value: InertSharedWorker,
  configurable: true,
  writable: true,
});

// Grants every request at once (on a microtask, like the real API) and holds it
// until the callback's promise settles. No queueing: nothing in a jsdom suite
// contends for a lock — the transport's lock names are unique per port.
const inertLocks = {
  request(
    _name: string,
    _options: unknown,
    callback: () => unknown,
  ): Promise<unknown> {
    return Promise.resolve().then(callback);
  },
};

Object.defineProperty(navigator, "locks", {
  value: inertLocks,
  configurable: true,
});
