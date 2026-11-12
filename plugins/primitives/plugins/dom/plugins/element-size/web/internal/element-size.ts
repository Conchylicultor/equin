import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type DependencyList,
} from "react";
import { flushSync } from "react-dom";

import {
  afterLayout,
  observeInPhase,
  runAsAfterLayout,
  type AfterLayoutRead,
} from "@plugins/primitives/plugins/dom/plugins/after-layout/web";
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
 * - **once on mount** (and when `deps` change), in the frame's after-layout
 *   phase (`dom/after-layout`): after the browser's own style/layout pass and
 *   before paint, batched with every other read — no first-paint flash, and no
 *   forced style recalc on React's commit path. The `target` getter is resolved
 *   there too, so it may read layout (`offsetParent`). Under jsdom the phase
 *   runs at once: the synchronous measure a test asserts after render,
 * - then on every observed resize, **RAF-debounced** by default (coalesces
 *   bursts and sidesteps the "ResizeObserver loop completed" warning).
 *
 * `onResize` may return a write (a DOM mutation built from what it read): in
 * the after-layout phase it runs after every read of the batch, so it never
 * dirties style between two other readers' reads.
 *
 * `onResize` is stabilised internally ({@link useEventCallback}), so it always
 * sees the latest closure without re-subscribing the observer. Pass `deps` to
 * force a re-measure when caller-side parameters change (the analog of the
 * dependency array on the bespoke effects this replaces).
 *
 * `beforePaint: true` — for a size that DECIDES LAYOUT (which columns a table
 * shows): each resize runs `onResize` inside the observer callback, before
 * the frame paints, and commits its React updates there (`flushSync`) — so
 * the frame that resizes the element is the frame that lays it out anew,
 * never one painting the old layout squeezed into the new size. Implies no
 * debounce. Keep the layout it changes inside the observed elements (the
 * browser re-delivers what grows deeper, and reports a loop for what grows
 * above).
 */
export function useResizeObserver(
  target: ResizeTarget,
  onResize: AfterLayoutRead,
  options?: { debounce?: boolean; deps?: DependencyList; beforePaint?: true },
): void {
  const beforePaint = options?.beforePaint === true;
  const debounce = !beforePaint && (options?.debounce ?? true);
  const deps = options?.deps ?? [];
  const handler = useEventCallback(onResize);

  useLayoutEffect(() => {
    let rafId: number | null = null;
    let observer: ResizeObserver | null = null;
    const runNow = () => handler()?.();
    const schedule = beforePaint
      ? () => flushSync(runNow)
      : debounce
        ? () => {
            if (rafId !== null) cancelAnimationFrame(rafId);
            rafId = requestAnimationFrame(runNow);
          }
        : runNow;

    // Resolve, subscribe and take the initial measure after layout — never on
    // the commit path, where each read forces a full style recalc.
    const cancelObserves: (() => void)[] = [];
    const cancelInitial = afterLayout(() => {
      const elements = resolveTargets(target);
      if (elements.length === 0) return;
      const created = new ResizeObserver((entries) =>
        runAsAfterLayout(
          schedule,
          entries.map((e) => e.target),
        ),
      );
      observer = created;
      for (const el of elements)
        cancelObserves.push(observeInPhase(created, el));
      return handler();
    });

    return () => {
      cancelInitial();
      for (const cancel of cancelObserves) cancel();
      observer?.disconnect();
      if (rafId !== null) cancelAnimationFrame(rafId);
    };
    // `handler` is stable; `target` is read at effect time (stable refs, or a
    // getter re-evaluated each run). Re-subscribe only on `debounce`/`deps`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handler, debounce, beforePaint, ...deps]);
}

/**
 * Reactively measure an element's LAYOUT size — its border box in its own CSS
 * pixels (fractional), as the `ResizeObserver` reports it. Returns a **callback
 * ref** — attach it to the node to measure; remounts and node swaps are
 * handled. Size is `{ 0, 0 }` until the first measure (and stays so under
 * jsdom, which has no layout).
 *
 * Layout size, never the visual one (`getBoundingClientRect`): the size is
 * re-read only when the observer says it changed, and the observer watches the
 * layout box — a transform on the element or an ancestor (a window's open
 * tween scaling it from 0.96, a scaled preview) changes the visual size with
 * no notification. A visual read taken under a transform was therefore frozen
 * until some unrelated layout change corrected it: a DataView measured inside
 * an opening desktop window published a 61.4375px toolbar height (64 × 0.96)
 * as `--dv-header-offset`, and the first full-screen switch then re-published
 * 64px, restyling every element of the view (~20k on Sonata's library). Every
 * consumer feeds the size back into CSS lengths in the element's own space
 * (sticky offsets, paddings, fold breakpoints), which is the layout size.
 *
 * Both measures come from the observer's own entries, so the value and its
 * change signal are one quantity. The node is observed on the commit path
 * (`observeInPhase`): mounted by an ordinary commit, its first notification is
 * delivered in the next step's first broadcast, together with the after-layout
 * root trigger — so the commit it makes there (`flushSync`, before paint: no
 * first-paint flash) may change layout at any depth without the browser
 * holding a notification back. Later measures are RAF-debounced, like
 * `useResizeObserver`'s. Horizontal writing modes: `width` is the inline size,
 * `height` the block one.
 *
 * `target` lets you attach the ref to one node but measure another — e.g.
 * `useElementSize((el) => el.offsetParent)` measures the offset parent while
 * the ref stays on the anchor child. It may read layout, so it is resolved in
 * the after-layout phase and observed from there: its first notification comes
 * in a later broadcast of the same step, whose commit must stay inside what
 * that broadcast can still deliver (the measured host's own subtree).
 */
export function useElementSize<T extends HTMLElement = HTMLElement>(
  target?: (el: T) => Element | null | undefined,
): [(node: T | null) => void, ElementSize] {
  const [size, setSize] = useState<ElementSize>({ width: 0, height: 0 });
  const [node, setNode] = useState<T | null>(null);
  const setRef = useCallback((next: T | null) => setNode(next), []);
  const resolveTarget = useEventCallback(target ?? ((el: T) => el));
  const resolves = target !== undefined;

  useLayoutEffect(() => {
    if (node === null) return;
    let latest: ElementSize | null = null;
    let delivered = false;
    let rafId: number | null = null;
    const apply = () => {
      rafId = null;
      const next = latest;
      if (next === null) return;
      setSize((prev) =>
        prev.width === next.width && prev.height === next.height ? prev : next,
      );
    };
    const observer = new ResizeObserver((entries) => {
      const box = entries.at(-1)?.borderBoxSize[0];
      if (box === undefined) return;
      latest = { width: box.inlineSize, height: box.blockSize };
      if (!delivered) {
        delivered = true;
        runAsAfterLayout(
          () => flushSync(apply),
          entries.map((e) => e.target),
        );
        return;
      }
      if (rafId !== null) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(apply);
    });
    let cancelObserve = (): void => {};
    const cancelResolve = resolves
      ? afterLayout(() => {
          const el = resolveTarget(node);
          if (el) cancelObserve = observeInPhase(observer, el);
        })
      : ((cancelObserve = observeInPhase(observer, node)), () => {});
    return () => {
      cancelResolve();
      cancelObserve();
      observer.disconnect();
      if (rafId !== null) cancelAnimationFrame(rafId);
    };
  }, [node, resolves, resolveTarget]);

  return [setRef, size];
}

/**
 * Observe a CHANGING set of elements — rows a windowed list mounts and unmounts
 * — through ONE observer. Returns a stable `observe(el)` that starts watching
 * `el` and returns its own release (a React 19 ref-callback cleanup): spread it
 * as `ref={(el) => observe(el)}`. `onResize(targets)` runs once for each newly
 * observed element in the after-layout phase (the {@link useResizeObserver}
 * first-measure rule), then with every element whose size changed, RAF-batched. The observer
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
      const cancelObserve = observeInPhase(observer, el);
      // First measure after layout (no forced recalc in the ref callback),
      // before paint (no first-paint flash).
      const cancelFirst = afterLayout(() => {
        if (el.isConnected) handler([el]);
      });
      return () => {
        cancelFirst();
        cancelObserve();
        observer.unobserve(el);
        state.pending.delete(el);
      };
    },
    [handler],
  );
}
