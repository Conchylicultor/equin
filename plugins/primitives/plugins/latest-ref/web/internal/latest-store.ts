import { useLayoutEffect, useReducer, useState } from "react";
import { useLatestRef } from "./latest-ref";

/**
 * The latest value of something a component renders, readable by its
 * descendants one answer at a time. Its identity never changes, so handing it
 * down (in a context, as a prop) re-renders nothing; what a reader re-renders
 * on is its own selector's answer (`useLatestSelector`).
 */
export interface LatestStore<T> {
  /** The value published last — current in an event handler or an effect. */
  get(): T;
  subscribe(listener: () => void): () => void;
}

/**
 * Publish `value` to a {@link LatestStore} of stable identity. The value is
 * published after each commit (a layout effect, before paint), and a reader
 * whose answer changed re-renders right then, in the same task — so a value
 * that changes on every render (a callback, an index rebuilt per render)
 * reaches a hundred memoized rows without re-rendering the ninety-eight whose
 * answer stayed the same.
 *
 * A reader mounting in the render that changed `value` reads the value
 * published before it, and is corrected by that same publish, before paint:
 * readers subscribe in a layout effect, and a child's layout effects run
 * before its parent's.
 */
export function useLatestStore<T>(value: T): LatestStore<T> {
  const [store] = useState(() => createLatestStore(value));
  useLayoutEffect(() => {
    store.publish(value);
  }, [store, value]);
  return store;
}

/**
 * One answer read from a {@link LatestStore}: re-renders the caller only when
 * `select`'s answer changes (`Object.is`). `select` may close over the caller's
 * props (it is re-run every render); it must answer a primitive or a reference
 * that is stable while the answer is the same — a fresh object per call would
 * never compare equal.
 */
export function useLatestSelector<T, R>(
  store: LatestStore<T>,
  select: (value: T) => R,
): R {
  const answer = select(store.get());
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const rendered = useLatestRef({ select, answer });
  // Subscribed in a LAYOUT effect, not `useSyncExternalStore`'s passive one:
  // the publisher publishes in its own layout effect, which runs after its
  // descendants', so a reader mounted in the same commit is already
  // listening and re-renders before paint. The check on subscribe covers a
  // publish that landed between this render and the subscription.
  useLayoutEffect(() => {
    const check = () => {
      const { select: current, answer: shown } = rendered.current;
      if (!Object.is(current(store.get()), shown)) rerender();
    };
    check();
    return store.subscribe(check);
  }, [store, rendered]);
  return answer;
}

function createLatestStore<T>(
  initial: T,
): LatestStore<T> & { publish(next: T): void } {
  let current = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => current,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    publish(next) {
      if (Object.is(next, current)) return;
      current = next;
      for (const listener of listeners) listener();
    },
  };
}
