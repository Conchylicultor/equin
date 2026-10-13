import { useSyncExternalStore } from "react";

// Deferred-load signal — a tiny module-level external store that broadcasts how
// far the post-paint deferred plugin tier has progressed, and which plugins
// failed to load.
//
// WHY it exists: with deferred loading (see load-tiers.ts), a cold deep-link into
// an app paints the chrome + app shell immediately but the route's *content*
// pane may belong to a plugin that hasn't loaded yet — so the pane router finds
// no match for a beat. The layout host consumes this signal to render a loading
// placeholder for an unmatched route **while deferred loading is still in
// progress**, only falling through to not-found once loading has settled. It is
// the boot loader's one-way progress beacon; the UX that reads it lives in the
// layout host plugin.
//
// A failed load is not just "settled": its plugin path is tracked in
// `failedPluginPaths` so a consumer can tell "route not resolvable yet" from
// "route's plugin chunk failed to load" (`hasLoadErrorUnder(prefix)`) and render
// an error surface instead of falling through to not-found. Each failure also
// fires `pluginLoadReportSink` so the reports plugin can file a crash task.
//
// App.tsx (the boot sequencer) is the sole writer: it calls
// `markDeferredPluginsLoaded` after each batch appends, `markDeferredPluginsFailed`
// for that batch's load errors, and `markDeferredLoadComplete` once every
// deferred entry has loaded or failed (a failed load still counts as settled so
// the placeholder can resolve to not-found / error instead of spinning forever).

/** Neutral report payload for a single plugin that failed to load. */
export interface PluginLoadReport {
  pluginPath: string;
  message: string;
}

// Soft-reporter slot mapping a plugin-load failure to a filed report. The reports
// plugin registers the handler; emit() never throws (it runs on the boot error
// path). Kept here — not wired to the `report-sink` primitive — on purpose:
// web-sdk is the base framework layer and must not depend on a `primitives/`
// plugin, and `report-sink`'s own web barrel imports web-sdk, so importing its
// core would form a plugin-level import cycle. This is the same contract as
// `defineReportSink`, restated for this one base-layer sink — keep the two alike.
//
// A failure emitted before the handler registers is HELD, not dropped: App.tsx
// emits the core-stage failures right after its first setState, before the
// reporter's mount effect has run. The next register(fn) replays them in order.
// register(null) discards what is held. Bounded to the FIRST 100 (the first
// failures are the cause, the rest their cascade); later ones are dropped with
// one warning per overflow.
const PLUGIN_LOAD_HOLD_CAP = 100;

export const pluginLoadReportSink: {
  register(fn: ((body: PluginLoadReport) => void) | null): void;
  emit(body: PluginLoadReport): void;
} = (() => {
  let handler: ((body: PluginLoadReport) => void) | null = null;
  let held: PluginLoadReport[] = [];
  let overflowWarned = false;

  function deliver(
    fn: (body: PluginLoadReport) => void,
    body: PluginLoadReport,
  ): void {
    try {
      fn(body);
      // eslint-disable-next-line promise-safety/no-bare-catch -- reporting must never throw on the boot error path; a throw from the registered handler is swallowed here
    } catch {
      // ignore
    }
  }

  return {
    register(fn) {
      handler = fn;
      const pending = held;
      held = [];
      overflowWarned = false;
      if (fn) for (const body of pending) deliver(fn, body);
    },
    emit(body) {
      if (handler) {
        deliver(handler, body);
      } else if (held.length < PLUGIN_LOAD_HOLD_CAP) {
        held.push(body);
      } else if (!overflowWarned) {
        overflowWarned = true;
        console.warn(
          `[plugin-load] ${PLUGIN_LOAD_HOLD_CAP} load failures held with no reporter registered; dropping newer ones until one registers`,
        );
      }
    },
  };
})();

export interface DeferredLoadState {
  /** Dotted plugin ids (`LoadedPlugin.id`) loaded in the deferred tier so far. */
  loadedPluginIds: ReadonlySet<string>;
  /** True once the deferred tier has fully settled (all loaded or failed). */
  deferredComplete: boolean;
  /** Fs-registry dirs (`PluginLoadError.pluginPath`) that failed to load. */
  failedPluginPaths: ReadonlySet<string>;
}

// A fresh snapshot object is minted on every change so `useSyncExternalStore`'s
// referential comparison detects it; between changes the SAME reference is
// returned (required — a new object each getSnapshot would loop forever). The
// field selectors below read single fields, each also stable between changes.
/* eslint-disable scoped-store/no-module-mutable-store -- page-global by design: the plugin registry loads ONCE per page at the App root (the single writer), so which deferred plugins have loaded is a page-wide fact shared identically by every keep-alive/desktop surface mount — a per-surface scoped store would be semantically wrong (each surface would track its own load state for the one shared registry). */
let loadedPluginIds: Set<string> = new Set();
let deferredComplete = false;
let failedPluginPaths: Set<string> = new Set();
let snapshot: DeferredLoadState = {
  loadedPluginIds,
  deferredComplete,
  failedPluginPaths,
};
/* eslint-enable scoped-store/no-module-mutable-store */

const listeners = new Set<() => void>();

function emit(): void {
  snapshot = { loadedPluginIds, deferredComplete, failedPluginPaths };
  for (const l of listeners) l();
}

/** Record a freshly-loaded deferred batch's plugin ids. No-op for an empty batch. */
export function markDeferredPluginsLoaded(ids: string[]): void {
  if (ids.length === 0) return;
  // Copy-on-write so the exposed set is never mutated after being handed out.
  loadedPluginIds = new Set(loadedPluginIds);
  for (const id of ids) loadedPluginIds.add(id);
  emit();
}

/** Mark the deferred tier fully settled. Idempotent. */
export function markDeferredLoadComplete(): void {
  if (deferredComplete) return;
  deferredComplete = true;
  emit();
}

/** Record plugin paths that failed to load. No-op for an empty batch. */
export function markDeferredPluginsFailed(paths: string[]): void {
  if (paths.length === 0) return;
  // Copy-on-write so the exposed set is never mutated after being handed out.
  failedPluginPaths = new Set(failedPluginPaths);
  for (const p of paths) failedPluginPaths.add(p);
  emit();
}

// Imperative (non-hook) check for a load error under a plugin-path subtree. An
// empty prefix returns false — a load error is only ever attributed to a
// concrete subtree, never treated as a global "anything failed" flag.
export function hasLoadErrorUnder(pathPrefix: string): boolean {
  if (pathPrefix === "") return false;
  for (const p of failedPluginPaths) {
    if (p.startsWith(pathPrefix)) return true;
  }
  return false;
}

/** Reactive check for a load error under a plugin-path subtree (re-renders on new failures). */
export function useHasLoadErrorUnder(prefix: string): boolean {
  return useSyncExternalStore(
    subscribeDeferredLoadState,
    () => hasLoadErrorUnder(prefix),
    () => hasLoadErrorUnder(prefix),
  );
}

/** Imperative (non-hook) read of the current deferred-load state. */
export function getDeferredLoadState(): DeferredLoadState {
  return snapshot;
}

/**
 * TEST-ONLY: reset the module-global deferred-load state to its initial values
 * (empty loaded/failed sets, not-yet-settled) and notify subscribers.
 *
 * WHY: this store is a page-global singleton whose sole runtime writer is
 * App.tsx at boot. A vitest file shares ONE module instance across its cases, so
 * any suite that flips completion (`markDeferredLoadComplete`) or records a
 * failure (`markDeferredPluginsFailed`) MUST call this between cases to stay
 * order-independent. Never call from product code — App.tsx owns the runtime
 * writes.
 */
export function resetDeferredLoadStateForTests(): void {
  loadedPluginIds = new Set();
  deferredComplete = false;
  failedPluginPaths = new Set();
  emit();
}

/** Subscribe to deferred-load state changes; returns an unsubscribe fn. */
export function subscribeDeferredLoadState(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Reactive: has the deferred tier settled? Re-renders once, at completion —
 * not on every loaded batch, as a whole-state read would.
 */
export function useDeferredLoadComplete(): boolean {
  return useSyncExternalStore(
    subscribeDeferredLoadState,
    () => deferredComplete,
    () => deferredComplete,
  );
}

/** Reactive: the plugin paths that failed to load (re-renders on new failures only). */
export function useFailedPluginPaths(): ReadonlySet<string> {
  return useSyncExternalStore(
    subscribeDeferredLoadState,
    () => failedPluginPaths,
    () => failedPluginPaths,
  );
}
