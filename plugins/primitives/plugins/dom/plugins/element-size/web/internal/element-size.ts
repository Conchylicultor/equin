import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type DependencyList,
} from "react";

import { useEventCallback } from "@plugins/primitives/plugins/latest-ref/web";

export type ElementSize = { width: number; height: number };

type RefLike = { readonly current: Element | null };

/**
 * What to observe. A ref (or array of refs) is read at effect time — stable
 * `RefObject`s, so the observer subscribes once. A getter is also called at
 * effect time and may return a lazily-resolved node (e.g. an `offsetParent` or
 * `parentElement`) or several nodes. Re-subscription is driven by `deps`, not by
 * the target's identity, so an inline getter never re-subscribes every render.
 */
export type ResizeTarget =
  | RefLike
  | readonly RefLike[]
  | (() => Element | readonly Element[] | null | undefined);

function resolveTargets(target: ResizeTarget): Element[] {
  if (typeof target === "function") {
    const resolved = target();
    if (!resolved) return [];
    return (Array.isArray(resolved) ? resolved : [resolved]).filter(
      (el): el is Element => el != null,
    );
  }
  const refs = Array.isArray(target) ? target : [target as RefLike];
  return refs
    .map((ref) => ref.current)
    .filter((el): el is Element => el != null);
}

/**
 * The single sanctioned home for the "observe element size via `ResizeObserver`"
 * idiom that was hand-rolled across the repo. Runs `onResize`:
 *
 * - **synchronously once** on mount (and when `deps` change) — no first-paint
 *   flash, and enough to decide layout under a no-op observer (jsdom tests),
 * - then on every observed resize, **RAF-debounced** by default (coalesces
 *   bursts and sidesteps the "ResizeObserver loop completed" warning).
 *
 * `onResize` is stabilised internally ({@link useEventCallback}), so it always
 * sees the latest closure without re-subscribing the observer. Pass `deps` to
 * force a re-measure when caller-side parameters change (the analog of the
 * dependency array on the bespoke effects this replaces).
 */
export function useResizeObserver(
  target: ResizeTarget,
  onResize: () => void,
  options?: { debounce?: boolean; deps?: DependencyList },
): void {
  const debounce = options?.debounce ?? true;
  const deps = options?.deps ?? [];
  const handler = useEventCallback(onResize);

  useLayoutEffect(() => {
    const elements = resolveTargets(target);
    if (elements.length === 0) return;

    let rafId: number | null = null;
    const schedule = debounce
      ? () => {
          if (rafId !== null) cancelAnimationFrame(rafId);
          rafId = requestAnimationFrame(handler);
        }
      : handler;

    const observer = new ResizeObserver(schedule);
    for (const el of elements) observer.observe(el);
    handler(); // synchronous initial measure — no first-paint flash

    return () => {
      observer.disconnect();
      if (rafId !== null) cancelAnimationFrame(rafId);
    };
    // `handler` is stable; `target` is read at effect time (stable refs, or a
    // getter re-evaluated each run). Re-subscribe only on `debounce`/`deps`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handler, debounce, ...deps]);
}

/**
 * Reactively measure an element's rendered size (`getBoundingClientRect`, so
 * fractional and transform-aware). Returns a **callback ref** — attach it to the
 * node to measure; remounts and node swaps are handled. Size is `{ 0, 0 }` until
 * the first measure.
 *
 * `target` lets you attach the ref to one node but measure another — e.g.
 * `useElementSize((el) => el.offsetParent)` measures the offset parent while the
 * ref stays on the anchor child.
 */
export function useElementSize<T extends HTMLElement = HTMLElement>(
  target: (el: T) => Element | null | undefined = (el) => el,
): [(node: T | null) => void, ElementSize] {
  const [size, setSize] = useState<ElementSize>({ width: 0, height: 0 });
  const [node, setNode] = useState<T | null>(null);
  const setRef = useCallback((next: T | null) => setNode(next), []);

  useResizeObserver(
    () => (node ? target(node) : null),
    () => {
      const el = node ? target(node) : null;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      setSize((prev) =>
        prev.width === rect.width && prev.height === rect.height
          ? prev
          : { width: rect.width, height: rect.height },
      );
    },
    { deps: [node] },
  );

  return [setRef, size];
}

/**
 * Observe a CHANGING set of elements — rows a windowed list mounts and unmounts
 * — through ONE observer. Returns a stable `observe(el)` that starts watching
 * `el` and returns its own release (a React 19 ref-callback cleanup): spread it
 * as `ref={(el) => observe(el)}`. `onResize(targets)` runs synchronously once
 * for each newly observed element (the {@link useResizeObserver} first-measure
 * rule), then with every element whose size changed, RAF-batched. The observer
 * is created on first use and disconnected on unmount; `onResize` is
 * stabilised, so it always sees the latest closure.
 */
export function useResizeObserverSet(
  onResize: (targets: readonly Element[]) => void,
): (el: Element) => () => void {
  const handler = useEventCallback(onResize);
  const ref = useRef<{
    observer: ResizeObserver | null;
    pending: Set<Element>;
    rafId: number | null;
  }>({ observer: null, pending: new Set(), rafId: null });

  useLayoutEffect(() => {
    const state = ref.current;
    return () => {
      state.observer?.disconnect();
      state.observer = null;
      if (state.rafId !== null) cancelAnimationFrame(state.rafId);
      state.rafId = null;
      state.pending.clear();
    };
  }, []);

  return useCallback(
    (el: Element) => {
      const state = ref.current;
      if (state.observer === null) {
        state.observer = new ResizeObserver((entries) => {
          for (const entry of entries) state.pending.add(entry.target);
          if (state.rafId !== null) return;
          state.rafId = requestAnimationFrame(() => {
            state.rafId = null;
            const targets = [...state.pending].filter((t) => t.isConnected);
            state.pending.clear();
            if (targets.length > 0) handler(targets);
          });
        });
      }
      const observer = state.observer;
      observer.observe(el);
      handler([el]); // synchronous first measure — no first-paint flash
      return () => {
        observer.unobserve(el);
        state.pending.delete(el);
      };
    },
    [handler],
  );
}
