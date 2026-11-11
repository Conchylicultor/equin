// ── Reading the browser while rendering ──────────────────────────────────────
//
// A component that reads `window` / `document` / `navigator` / `matchMedia`
// straight in its body breaks twice: a static render (no DOM at all) throws
// `ReferenceError`, and the live app reads the value once and never again (a
// `useState(() => window.innerWidth)` is stale after the first resize). These
// hooks are the one place that read happens: live, through
// `useSyncExternalStore` (re-read on every change the caller subscribes to);
// in a static render, never — the caller's `staticValue` is rendered instead,
// or, with none, the render fails naming what had no static form.
//
// The `dom-access-safety/no-render-time-dom` lint rule sends every render-time
// browser read here.

import { useMemo, useState, useSyncExternalStore } from "react";
import { renderMode } from "../../core";

/** Thrown when a static render reaches a browser value that has no static form. */
export class NoStaticValueError extends Error {
  constructor(name: string) {
    super(
      `[render-mode] "${name}" is read from the browser and has no static form — ` +
        "a static render (HTML for robots, no DOM) cannot draw this component. " +
        "Give the read a `staticValue`, or branch on `renderMode()` above it.",
    );
    this.name = "NoStaticValueError";
  }
}

export interface BrowserValueOptions<T> {
  /** What the value is, for the error a static render without `staticValue` throws. */
  name: string;
  /**
   * Reads the value from the browser. Called while rendering (live only), so it
   * must return a primitive or a cached object — a fresh object per call makes
   * `useSyncExternalStore` re-render forever.
   */
  read: () => T;
  /** Calls `onChange` whenever `read()` may answer differently; returns the unsubscribe. Omitted: the value never changes for the life of the page. */
  subscribe?: (onChange: () => void) => () => void;
  /** What a static render draws instead. Omitted: a static render throws {@link NoStaticValueError}. */
  staticValue?: T;
}

const NEVER_CHANGES = (): (() => void) => () => undefined;

/**
 * A value read from the browser, kept current: live, `read()` re-read on every
 * `subscribe` notification; in a static render, `staticValue` (or a loud
 * {@link NoStaticValueError}). Keep `subscribe` / `read` stable (module-level
 * or memoized) — a new `subscribe` each render re-subscribes each render.
 */
export function useBrowserValue<T>(options: BrowserValueOptions<T>): T {
  const { name, read, subscribe = NEVER_CHANGES } = options;
  const hasStatic = "staticValue" in options;
  const staticValue = options.staticValue;
  const staticSnapshot = (): T => {
    if (!hasStatic) throw new NoStaticValueError(name);
    return staticValue as T;
  };
  return useSyncExternalStore(
    subscribe,
    // A client render under a declared static mode (a jsdom test) reads the
    // static value too, so a test sees what the static HTML shows.
    renderMode() === "static" ? staticSnapshot : read,
    staticSnapshot,
  );
}

/** Whether `query` (a CSS media query) matches now, kept current; `staticValue` in a static render. */
export function useMediaQuery(query: string, staticValue: boolean): boolean {
  // One MediaQueryList per query, made on first use (never in a static render).
  const { subscribe, read } = useMemo(() => {
    let list: MediaQueryList | undefined;
    const get = (): MediaQueryList => (list ??= window.matchMedia(query));
    return {
      subscribe: (onChange: () => void) => {
        const l = get();
        l.addEventListener("change", onChange);
        return () => l.removeEventListener("change", onChange);
      },
      read: () => get().matches,
    };
  }, [query]);
  return useBrowserValue({
    name: `matchMedia(${query})`,
    read,
    subscribe,
    staticValue,
  });
}

export interface ViewportSize {
  width: number;
  height: number;
}

function subscribeResize(onChange: () => void): () => void {
  window.addEventListener("resize", onChange);
  return () => window.removeEventListener("resize", onChange);
}
const readWidth = (): number => window.innerWidth;
const readHeight = (): number => window.innerHeight;

/**
 * The window's inner size, kept current by its resize events; `staticValue` in
 * a static render (omitted: a static render throws {@link NoStaticValueError}).
 */
export function useViewportSize(staticValue?: ViewportSize): ViewportSize {
  const width = useBrowserValue({
    name: "window.innerWidth",
    read: readWidth,
    subscribe: subscribeResize,
    ...(staticValue && { staticValue: staticValue.width }),
  });
  const height = useBrowserValue({
    name: "window.innerHeight",
    read: readHeight,
    subscribe: subscribeResize,
    ...(staticValue && { staticValue: staticValue.height }),
  });
  return useMemo(() => ({ width, height }), [width, height]);
}

/**
 * A DOM element this component owns for its whole life — minted once, on the
 * first render, by `create(document)` (a portal container, a stage it moves
 * imperatively). It has no static form: a static render throws
 * {@link NoStaticValueError} naming `name`, so a building block that can be
 * reached by one branches on `renderMode()` above the hook.
 */
export function useOwnedElement<E extends Element>(
  name: string,
  create: (doc: Document) => E,
): E {
  const [element] = useState(() => {
    if (renderMode() === "static") throw new NoStaticValueError(name);
    return create(document);
  });
  return element;
}
