import {
  createContext,
  createElement,
  lazy,
  Suspense,
  use,
  useCallback,
  useContext,
  useState,
  useSyncExternalStore,
  type ComponentType,
  type ReactNode,
} from "react";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { renderMode } from "@plugins/primitives/plugins/dom/plugins/render-mode/core";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import { holdFirstPaint } from "@plugins/framework/plugins/web-sdk/core";
import { startBackgroundLoad } from "@plugins/primitives/plugins/networking/plugins/background-loads/core";

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
   * grow when the chunk lands. Still off the boot path.
   *
   * `"first-paint"`: the page being opened draws this component in its first
   * frame. Its chunk starts loading at once, when the component is defined
   * (its module evaluates during the boot), and the first paint waits for it
   * (web-sdk's `holdFirstPaint`), so the frame is drawn with it rather than
   * with its fallback. Only for what the URL being opened is known to show:
   * every such chunk is on that page's critical path.
   *
   * Omitted: load on first mount.
   */
  preload?: "idle" | "first-paint";
}

/**
 * Whether a lazy component mounting here suspends the enclosing render rather
 * than drawing its own fallback. See {@link HoldLazyMount}.
 */
const HoldContext = createContext(false);

/**
 * While `active`, a lazy component whose chunk is not in yet and that MOUNTS
 * under here does not draw its fallback: it suspends the render it mounts in,
 * past its own boundary. For a host that mounts a whole new screen in a
 * deferred render (a pane navigation — `primitives/pane`'s surface renders a
 * `useDeferredValue` of its route): React then abandons that render and keeps
 * the previous screen on display until the chunk lands, instead of committing
 * the new screen with a spinner in place of its content.
 *
 * Only for a subtree mounted by a deferred or transition render: in an urgent
 * render the suspension would hide the nearest revealed Suspense boundary
 * above (or hold the whole root). So a host turns it on only while its
 * subtree first mounts, and off once it has committed — a lazy component
 * mounting later (a dialog opened by a click) draws its own fallback as ever.
 * A lazy component reads it once, when it mounts.
 */
export function HoldLazyMount({
  active,
  children,
}: {
  active: boolean;
  children: ReactNode;
}): ReactNode {
  return createElement(HoldContext.Provider, { value: active }, children);
}

/**
 * Every lazy component's chunk loader (memoized: `React.lazy` and a preload share
 * one import). Read only by `loadLazyComponents` (`web/testing`).
 */
export const loaders = new Set<() => Promise<unknown>>();

/** Where a lazy component's chunk stands, read by `useLazyReady`. */
type ChunkState =
  { kind: "loading" } | { kind: "loaded" } | { kind: "failed"; error: unknown };

interface Chunk {
  load: () => Promise<unknown>;
  state: () => ChunkState;
}

/** Each component `lazyComponent` returned, to its chunk. */
const chunks = new WeakMap<object, Chunk>();

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
  let state: ChunkState = { kind: "loading" };
  const load = () =>
    (loading ??= loader().then(
      (m) => {
        loaded = m.default;
        state = { kind: "loaded" };
        return m;
      },
      (error: unknown) => {
        state = { kind: "failed", error };
        throw error;
      },
    ));
  const readLoaded = () => loaded;
  loaders.add(load);
  if (opts?.preload === "idle") preloadWhenIdle(load);
  if (opts?.preload === "first-paint") preloadForFirstPaint(load);
  const Lazy = lazy(load);
  // Not `??`: that reads an explicit `fallback: null` as "none given" and draws
  // the spinner an inline widget asked not to flash.
  const fallback =
    opts?.fallback === undefined ? (
      <Center axis="horizontal">
        <Loading variant="spinner" />
      </Center>
    ) : (
      opts.fallback
    );
  const LazyBoundary = function LazyBoundary(props: P) {
    // Read once, at mount, like `Loaded` below: an instance never switches
    // between suspending past itself and its own boundary.
    const holdHere = useContext(HoldContext);
    const [hold] = useState(() => holdHere);
    // An instance mounted after the chunk loaded renders it directly: through
    // `React.lazy` it would still suspend once (lazy learns of a resolved
    // promise a microtask late) and wait out React's 300 ms Suspense reveal
    // throttle. Chosen once per instance, so an instance never switches trees.
    //
    // `readLoaded`, not an inline `() => loaded`: the React Compiler outlines a
    // closure it thinks captures nothing to module scope, where the factory's
    // `loaded` does not exist.
    const [Loaded] = useState(readLoaded);
    if (Loaded) return <Loaded {...props} />;
    // A static render (one render to HTML, never hydrated — `dom/render-mode`)
    // has no later paint to pop the chunk into, and the prerender renders a
    // Suspense fallback eagerly, so the loading state would ship as content:
    // suspend on the load here instead (the prerender waits for Suspense) and
    // render the component. `load` is memoized, so every retry reads the same
    // promise; a failed load throws, like `useLazyReady`.
    //
    // Mounted by a deferred render under an active `HoldLazyMount`, the same:
    // the suspension reaches past this component to the render that mounted
    // it, which React abandons, keeping the previous screen until the chunk
    // is in. The retry mounts this instance afresh, reading the loaded
    // component above.
    if (hold || renderMode() === "static") {
      const { default: Component } = use(load());
      return <Component {...props} />;
    }
    return (
      <Suspense fallback={fallback}>
        <Lazy {...props} />
      </Suspense>
    );
  };
  chunks.set(LazyBoundary, { load, state: () => state });
  return LazyBoundary;
}

/**
 * Whether `component`'s chunk has loaded — starting the load if nothing has
 * yet, and re-rendering once it lands. For a host whose surface must not
 * change once shown: it holds its own loading state until the chunk is in, so
 * the lazy component inside renders at once rather than popping in after a
 * first paint drawn without it. A failed load throws here, into the host's
 * error boundary. In a static render it suspends until the chunk is in, so
 * it answers ready.
 *
 * `component` must be one `lazyComponent` returned.
 */
export function useLazyReady<P extends object>(
  component: ComponentType<P>,
): boolean {
  const chunk = chunks.get(component);
  if (chunk === undefined) {
    throw new Error("useLazyReady: not a component lazyComponent returned");
  }
  const subscribe = useCallback(
    (changed: () => void) => {
      // Settled either way, the state moved: re-read it (a failure is thrown
      // from the render below, and reported there).
      void chunk.load().then(changed, changed);
      return () => {};
    },
    [chunk],
  );
  // A server render subscribes to nothing, so it reads where the chunk stands
  // now and starts no load from here.
  const state = useSyncExternalStore(subscribe, chunk.state, chunk.state);
  if (state.kind === "failed") throw state.error;
  if (state.kind === "loaded") return true;
  // A static render (one render to HTML, never hydrated — `dom/render-mode`)
  // has no later paint to pop the chunk into: it suspends on the load (the
  // prerender waits for Suspense) and renders the host ready, rather than
  // writing its loading state into the page. `load` is memoized, so every
  // retry reads the same promise; a failed load throws here, like above.
  if (renderMode() === "static") {
    use(chunk.load());
    return true;
  }
  return false;
}

/**
 * Start `load` at once and hold the first paint for it — only in a page, like
 * {@link preloadWhenIdle}. A failed load fails the boot's "App code" task (the
 * boot screen says so); the first mount shares the same rejected import and
 * throws into its boundary.
 */
function preloadForFirstPaint(load: () => Promise<unknown>): void {
  if (typeof document === "undefined") return;
  holdFirstPaint(load());
}

/**
 * One-shot: run `load` when the main thread is next idle (Safari has no
 * `requestIdleCallback`: a macrotask then) — a background load, so while the
 * visitor waits on a download they asked for (`networking/background-loads`'s
 * `holdBackgroundLoads`), it waits too, and starts once that is in. Only in
 * a page — a module evaluated outside one (barrel introspection's fake `window` has no `document`) loads
 * nothing. A failed preload is left unhandled, so it is reported; the first
 * mount shares the same rejected import and throws into its boundary.
 */
function preloadWhenIdle(load: () => Promise<unknown>): void {
  if (typeof document === "undefined") return;
  const run = () => startBackgroundLoad(() => void load());
  if (typeof requestIdleCallback === "function") requestIdleCallback(run);
  else setTimeout(run, 0);
}
