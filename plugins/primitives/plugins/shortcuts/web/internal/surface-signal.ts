import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { usePluginScopeId } from "@plugins/framework/plugins/web-sdk/core";
import { useSurfaceTabId } from "@plugins/primitives/plugins/scope/plugins/surface-id/web";
import {
  getFocusedSurfaceId,
  subscribeFocusedSurface,
} from "./focused-surface";

// A surface signal: a value each surface publishes about itself ("the task
// this surface is about"), read by global chrome through the FOCUSED surface.
//
// Every entry carries the scope it was published from (`usePluginScopeId()`
// of the publisher), and a reader sees an entry only when it renders in that
// same scope. The focused surface is page-global (keyboard dispatch needs it),
// so a surface inside a `<PluginScope>` — the demo's embedded app — can be the
// focused one while page chrome reads; without the scope check page chrome
// would pick up an id that exists only behind the scope's host and resolve it
// through the page's own transport. Neither hook takes a scope: both read it
// from where they render, so there is no spelling that crosses one.

interface Entry<T> {
  owner: symbol;
  scope: string | null;
  value: T;
}

declare const surfaceSignalBrand: unique symbol;

/**
 * A named per-surface value; create once at module scope with
 * {@link defineSurfaceSignal}. Opaque: its entries are reachable only through
 * the two hooks below, which bind the scope.
 */
export interface SurfaceSignal<T> {
  readonly name: string;
  readonly [surfaceSignalBrand]: T;
}

interface SignalState<T> {
  name: string;
  /** Keyed by surface id. */
  bySurface: Map<string, Entry<T>>;
  listeners: Set<() => void>;
}

export function defineSurfaceSignal<T>(name: string): SurfaceSignal<T> {
  const state: SignalState<T> = {
    name,
    bySurface: new Map(),
    listeners: new Set(),
  };
  return state as unknown as SurfaceSignal<T>;
}

function stateOf<T>(signal: SurfaceSignal<T>): SignalState<T> {
  return signal as unknown as SignalState<T>;
}

function notify<T>(state: SignalState<T>): void {
  for (const l of state.listeners) l();
}

/**
 * Publish `value` as this surface's entry of `signal` (`null` publishes
 * nothing) for as long as the caller is mounted with it. Several publishers in
 * one surface: the latest wins, and one leaving clears only its own entry.
 * A no-op outside a surface. `value` is compared by identity — memoize an
 * object.
 */
export function useSurfaceSignal<T>(
  signal: SurfaceSignal<T>,
  value: T | null,
): void {
  const surfaceId = useSurfaceTabId();
  const scope = usePluginScopeId();
  const ownerRef = useRef(Symbol(signal.name));

  useEffect(() => {
    if (surfaceId === undefined || value === null) return;
    const owner = ownerRef.current;
    const state = stateOf(signal);
    state.bySurface.set(surfaceId, { owner, scope, value });
    notify(state);
    return () => {
      if (state.bySurface.get(surfaceId)?.owner !== owner) return;
      state.bySurface.delete(surfaceId);
      notify(state);
    };
  }, [signal, surfaceId, scope, value]);
}

/**
 * The focused surface's entry of `signal`, or `null` — also when that entry
 * was published from another scope than the one this renders in. Re-renders
 * on a publish or a focus change.
 */
export function useFocusedSurfaceSignal<T>(signal: SurfaceSignal<T>): T | null {
  const scope = usePluginScopeId();
  const subscribe = useCallback(
    (cb: () => void) => {
      const { listeners } = stateOf(signal);
      listeners.add(cb);
      const unsubFocus = subscribeFocusedSurface(cb);
      return () => {
        listeners.delete(cb);
        unsubFocus();
      };
    },
    [signal],
  );
  const getSnapshot = useCallback((): T | null => {
    const focused = getFocusedSurfaceId();
    const entry =
      focused === undefined
        ? undefined
        : stateOf(signal).bySurface.get(focused);
    return entry !== undefined && entry.scope === scope ? entry.value : null;
  }, [signal, scope]);
  return useSyncExternalStore(subscribe, getSnapshot, () => null);
}
