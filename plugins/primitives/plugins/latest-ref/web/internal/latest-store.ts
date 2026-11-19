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
  /** The value its publisher rendered last — what a reader rendering in the
   *  same pass selects from (`useLatestSelector`); never read it elsewhere. */
  rendered(): T;
  subscribe(listener: () => void): () => void;
}

/**
 * Publish `value` to a {@link LatestStore} of stable identity. A value that
 * changes on every render (a callback, an index rebuilt per render) reaches a
 * hundred memoized rows without re-rendering the ninety-eight whose answer
 * stayed the same.
 *
 * Two halves, so a change costs ONE commit:
 * - Staged in render: a reader rendering below in the same pass (its own
 *   props changed, or it is mounting) selects from the value being rendered,
 *   so it renders its final answer the first time.
 * - Published after the commit (a layout effect, before paint): it notifies
 *   the readers that did NOT render in that pass, and only the ones whose
 *   answer changed re-render — in the same task, before paint.
 *
 * Were readers to select from the published value instead, every reader
 * rendering in the commit that changed it would render the previous answer
 * and be corrected by the publish: a second commit re-rendering exactly the
 * readers that had just rendered (a search's rows: ~1,900 components, twice
 * a keystroke).
 */
export function useLatestStore<T>(value: T): LatestStore<T> {
  const [store] = useState(() => createLatestStore(value));
  store.stage(value);
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
  "use no memo";
  // "use no memo" -- the answer is read from a mutable store the compiler cannot see change: compiled, `select(store.rendered())` is cached on [select, store], both stable for a row whose selector closes over an unchanged id, so the row kept its first answer forever and every publish re-rendered it to that same stale answer (an extra commit per publish).
  const answer = select(store.rendered());
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const rendered = useLatestRef({ select, answer });
  // Subscribed in a LAYOUT effect, not `useSyncExternalStore`'s passive one:
  // the publisher publishes in its own layout effect, which runs after its
  // descendants', so a reader mounted in the same commit is already
  // listening. The check on subscribe covers a value that moved between this
  // render and the subscription (staged by a later render of the publisher).
  useLayoutEffect(() => {
    const check = () => {
      const { select: current, answer: shown } = rendered.current;
      if (!Object.is(current(store.rendered()), shown)) rerender();
    };
    check();
    return store.subscribe(check);
  }, [store, rendered]);
  return answer;
}

interface StagedLatestStore<T> extends LatestStore<T> {
  /** Render half: the value the publisher is rendering (no notification). */
  stage(next: T): void;
  /** Commit half: the value committed; notifies every reader. */
  publish(next: T): void;
}

/**
 * `get` answers the committed value (an event handler acts on what is on
 * screen); `rendered` the value the publisher rendered last. They differ only
 * between a render and its commit — or after a render React discarded (an
 * interrupted transition), which the publisher's next commit re-stages and
 * publishes, correcting any reader that rendered from it meanwhile.
 */
function createLatestStore<T>(initial: T): StagedLatestStore<T> {
  let committed = initial;
  let staged = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => committed,
    rendered: () => staged,
    stage(next) {
      staged = next;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    publish(next) {
      staged = next;
      if (Object.is(next, committed)) return;
      committed = next;
      for (const listener of listeners) listener();
    },
  };
}
