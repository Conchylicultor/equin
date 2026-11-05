import {
  lazy,
  Suspense,
  useState,
  type ComponentType,
  type ReactNode,
} from "react";
import { Loading } from "@plugins/primitives/plugins/loading/web";

export interface LazyComponentOptions {
  /**
   * Node shown while the lazy chunk downloads/evaluates. Defaults to a delayed
   * `<Loading variant="spinner" />` — the Loading primitive fades in only after
   * ~120ms, so a fast chunk load never flashes a fallback. Pass a full-surface
   * fallback (e.g. a centered spinner) for a whole-pane component, or `null` for
   * an inline widget that should simply pop in — an explicit `null` is honoured,
   * only an omitted fallback gets the spinner.
   */
  fallback?: ReactNode;
  /**
   * `"idle"`: load the chunk once the page is idle after boot, so the first
   * mount renders synchronously instead of suspending. For a component that
   * appears in a surface whose size must not change once shown — an editor
   * inside a popover that opens on a click would otherwise open without it and
   * grow when the chunk lands. Still off the boot path; omitted: load on first
   * mount.
   */
  preload?: "idle";
}

/**
 * Every lazy component's chunk loader (memoized: `React.lazy` and a preload share
 * one import). Read only by `loadLazyComponents` (`web/testing`).
 */
export const loaders = new Set<() => Promise<unknown>>();

/**
 * Pairs `React.lazy` with its own `Suspense` boundary so a heavy component can be
 * code-split out of the eager plugin-boot wave (see
 * `web-core/CLAUDE.md` "Bundle analysis") without relying on an ambient Suspense
 * in the render path — there is none: slot-render, panes (`PaneResolveGuard`), and
 * app surfaces (`TabSurface`) all render `<Component/>` directly. The returned
 * component is a drop-in for the original: every call site keeps `<Foo {...props}/>`.
 *
 * `React.lazy` caches the resolved module, so only the FIRST mount in a session
 * suspends; later mounts render synchronously.
 *
 * Named exports use the standard idiom:
 *
 * ```ts
 * const GraphCanvas = lazyComponent(() =>
 *   import("./graph-canvas-impl").then((m) => ({ default: m.GraphCanvas })),
 * );
 * ```
 *
 * Note: the boundary does not forward `ref`. A component consumed with a `ref`
 * must expose its imperative handle another way (or wrap the impl in
 * `forwardRef` before lazy-loading).
 */
export function lazyComponent<P extends object>(
  loader: () => Promise<{ default: ComponentType<P> }>,
  opts?: LazyComponentOptions,
): ComponentType<P> {
  let loading: Promise<{ default: ComponentType<P> }> | undefined;
  let loaded: ComponentType<P> | undefined;
  const load = () =>
    (loading ??= loader().then((m) => {
      loaded = m.default;
      return m;
    }));
  loaders.add(load);
  if (opts?.preload === "idle") preloadWhenIdle(load);
  const Lazy = lazy(load);
  // Not `??`: that reads an explicit `fallback: null` as "none given" and draws
  // the spinner an inline widget asked not to flash.
  const fallback =
    opts?.fallback === undefined ? (
      <Loading variant="spinner" />
    ) : (
      opts.fallback
    );
  return function LazyBoundary(props: P) {
    // An instance mounted after the chunk loaded renders it directly: through
    // `React.lazy` it would still suspend once (lazy learns of a resolved
    // promise a microtask late) and wait out React's 300 ms Suspense reveal
    // throttle. Chosen once per instance, so an instance never switches trees.
    const [Loaded] = useState(() => loaded);
    if (Loaded) return <Loaded {...props} />;
    return (
      <Suspense fallback={fallback}>
        <Lazy {...props} />
      </Suspense>
    );
  };
}

/**
 * One-shot: run `load` when the main thread is next idle (Safari has no
 * `requestIdleCallback`: a macrotask then). Only in a page — a module evaluated
 * outside one (barrel introspection's fake `window` has no `document`) loads
 * nothing. A failed preload is left unhandled, so it is reported; the first
 * mount shares the same rejected import and throws into its boundary.
 */
function preloadWhenIdle(load: () => Promise<unknown>): void {
  if (typeof document === "undefined") return;
  const run = () => void load();
  if (typeof requestIdleCallback === "function") requestIdleCallback(run);
  else setTimeout(run, 0);
}
