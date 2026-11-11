import {
  createContext,
  createElement,
  useContext,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { DependencyList, ReactNode } from "react";
import { useLatestRef } from "@plugins/primitives/plugins/latest-ref/web";
import type { Hook } from "@plugins/framework/plugins/hook-value/core";

/**
 * Per-`<Provider>`-instance external store — the sanctioned replacement for the
 * ad-hoc `let x; const listeners = new Set(); useSyncExternalStore(...)`
 * module-singleton pattern.
 *
 * The factory ({@link defineScopedStore}) is module-level and stable, but the
 * STATE is created once per `<Provider>` mount: each React subtree (each app
 * surface) gets its own isolated store. A module-singleton store works only
 * while exactly one consumer mounts at a time; the moment two surfaces are
 * visible (multi-tab/-window), the singleton tears. Scoping the state to the
 * provider fixes that without giving up the external-store wins — imperative
 * reads/writes from a rAF loop (no React render), reactive whole-state reads,
 * and fine-grained selector subscriptions with re-render bailout (60fps reads
 * with no re-render storm).
 *
 * Three read paths, mirroring the `cursor-store` precedent this generalizes:
 *  - {@link ScopedStoreHandle.useStoreApi} — imperative, in-subtree; drive a
 *    handle or DOM transform with ZERO React renders.
 *  - {@link ScopedStoreHandle.useStore} — raw reactive whole-state; re-renders
 *    the caller on every change.
 *  - {@link ScopedStoreHandle.useSelector} — derived-with-bailout; re-renders
 *    only when the selected slice changes.
 */

export interface ScopedStore<S> {
  getState(): S;
  setState(next: S | ((prev: S) => S), opts?: { meta?: unknown }): void;
  subscribe(listener: (meta?: unknown) => void): () => void;
}

export interface ScopedStoreHandle<S> {
  Provider: (props: {
    children: ReactNode;
    initial?: S | (() => S);
  }) => ReactNode;
  /**
   * Imperative store handle for the current subtree — for rAF loops and
   * synchronous reads/writes that must not trigger a React render. Throws when
   * used outside the handle's own `<Provider>`.
   */
  useStoreApi: Hook<() => ScopedStore<S>>;
  /** Reactive whole-state read — re-renders the caller on every change. */
  useStore: Hook<() => S>;
  /**
   * Derived read with re-render bailout — a hand-rolled
   * `useSyncExternalStoreWithSelector`. Re-renders the caller ONLY when
   * `selector(state)` changes per `isEqual` (default `Object.is`).
   *
   * `deps` invalidate the cache exactly like `useMemo`'s deps: when the
   * selector closes over new data the same state can map to a new value, so the
   * cache must be dropped. Pass everything the selector reads besides `state`.
   * For selectors that build a FRESH object each call (so `Object.is` can never
   * match), pass an `isEqual` that compares by value.
   */
  useSelector: Hook<
    <T>(
      selector: (state: S) => T,
      deps: DependencyList,
      isEqual?: (a: T, b: T) => boolean,
    ) => T
  >;
}

function resolve<S>(initial: S | (() => S)): S {
  return typeof initial === "function" ? (initial as () => S)() : initial;
}

/**
 * Build the mutable store. Holds `state` + a listener set. `setState` resolves
 * an updater vs a value and bails when the next value is `Object.is`-equal to
 * the current one — keeping the snapshot identity referentially stable so
 * `useSyncExternalStore`'s tearing check does not loop — then notifies every
 * listener with `opts?.meta`.
 */
function createStore<S>(initial: S): ScopedStore<S> {
  let state = initial;
  const listeners = new Set<(meta?: unknown) => void>();

  return {
    getState(): S {
      return state;
    },
    setState(next: S | ((prev: S) => S), opts?: { meta?: unknown }): void {
      const value =
        typeof next === "function" ? (next as (prev: S) => S)(state) : next;
      if (Object.is(value, state)) return;
      state = value;
      for (const listener of listeners) listener(opts?.meta);
    },
    subscribe(listener: (meta?: unknown) => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

function depsChanged(a: DependencyList, b: DependencyList): boolean {
  if (a.length !== b.length) return true;
  for (let i = 0; i < a.length; i++) {
    if (!Object.is(a[i], b[i])) return true;
  }
  return false;
}

export function defineScopedStore<S>(
  defaultInitial: S | (() => S),
): ScopedStoreHandle<S> {
  const Ctx = createContext<ScopedStore<S> | null>(null);

  function Provider({
    children,
    initial,
  }: {
    children: ReactNode;
    initial?: S | (() => S);
  }): ReactNode {
    // Create the store ONCE per mount: each provider instance owns isolated
    // state. The lazy initializer runs only on the first render.
    const [store] = useState(() =>
      createStore(resolve(initial ?? defaultInitial)),
    );
    return createElement(Ctx.Provider, { value: store }, children);
  }

  function useStoreApi(): ScopedStore<S> {
    const s = useContext(Ctx);
    if (!s) throw new Error("scoped-store: hook used outside its <Provider>");
    return s;
  }

  function useStore(): S {
    const store = useStoreApi();
    return useSyncExternalStore(
      store.subscribe,
      store.getState,
      store.getState,
    );
  }

  function useSelector<T>(
    selector: (state: S) => T,
    deps: DependencyList,
    isEqual: (a: T, b: T) => boolean = Object.is,
  ): T {
    const store = useStoreApi();
    const selectorRef = useLatestRef(selector);
    const isEqualRef = useLatestRef(isEqual);

    // Cache keyed on the store's STATE identity keeps getSnapshot referentially
    // stable while the store hasn't moved (valid because setState bails on an
    // Object.is-equal state); reset when deps change so a new closed-over value
    // can't return a stale selection at an unchanged state.
    const cacheRef = useRef<{ state: S; value: T } | null>(null);
    const depsRef = useRef<DependencyList | null>(null);
    if (depsRef.current === null || depsChanged(depsRef.current, deps)) {
      depsRef.current = deps;
      cacheRef.current = null;
    }

    const getSnapshot = (): T => {
      const state = store.getState();
      const prev = cacheRef.current;
      if (prev !== null && Object.is(prev.state, state)) return prev.value;
      const next = selectorRef.current(state);
      if (prev !== null && isEqualRef.current(prev.value, next)) {
        // Value-equal across the state change: keep the previous reference so
        // useSyncExternalStore bails and the component does not re-render.
        cacheRef.current = { state, value: prev.value };
        return prev.value;
      }
      cacheRef.current = { state, value: next };
      return next;
    };

    return useSyncExternalStore(store.subscribe, getSnapshot, getSnapshot);
  }

  return { Provider, useStoreApi, useStore, useSelector };
}
