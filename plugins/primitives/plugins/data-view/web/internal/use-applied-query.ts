import { useDeferredValue, useState } from "react";

/** The view-state shape this hook reads: only its `query` is its business. */
interface Queried {
  readonly query: string;
}

/** `state` with `query` applied — `state` itself when it already holds it. */
function withQuery<S extends Queried>(state: S, query: string): S {
  return state.query === query ? state : { ...state, query };
}

/** Whether `a` and `b` hold the same values on every key but `query`. */
function sameButQuery(a: Queried, b: Queried): boolean {
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  for (const k of ka)
    if (
      k !== "query" &&
      (a as unknown as Record<string, unknown>)[k] !==
        (b as unknown as Record<string, unknown>)[k]
    )
      return false;
  return true;
}

/**
 * A view's search, split into what the field shows and what the rows get.
 *
 * `typed` is the query as typed — the search field reads it, so a keystroke
 * paints the field at once. `state` is the view's state with the query
 * APPLIED, which trails `typed` by a deferred render (`useDeferredValue`):
 * filtering the rows and re-rendering every part that reads them (the view,
 * the panels beside it, the counts) runs as background work React drops when
 * the next keystroke lands, never inside the keystroke's own frame. Every
 * other edit of the state (sort, filter, grouping, another view) is applied
 * at once, with the query as typed — a handler derives its next filter from
 * the one in effect, and a view must never be drawn with another's query.
 *
 * `state` keeps its identity while only the typed query moved (the stored
 * state of an uncontrolled search changes object on each keystroke): the
 * urgent render then hands every memo downstream the same object, so it bails
 * out instead of recomputing on the old query.
 *
 * @param stored - the view's stored state (`stateFor`: one object until it changes).
 * @param controlled - a controlled search's query (`search.query`), replacing the stored one.
 */
export function useAppliedQuery<S extends Queried>(
  stored: S,
  controlled: string | undefined,
): { typed: string; state: S } {
  const typed = controlled ?? stored.query;
  const applied = useDeferredValue(typed);
  // The render-phase "adjust state on prop change" pattern, two moves:
  // - something other than the typed query moved (an edit, another view, a
  //   controlled search let go): the new state takes the query as typed — a
  //   view is never drawn with another view's query;
  // - else, the deferred query moved: it is applied.
  // `applied` is remembered so a deferred value still trailing a query
  // already applied by the first move never takes the state back.
  const [held, setHeld] = useState(() => ({
    state: withQuery(stored, applied),
    applied,
  }));
  let state = held.state;
  if (!sameButQuery(held.state, stored)) {
    state = withQuery(stored, typed);
    setHeld({ state, applied });
  } else if (held.applied !== applied) {
    state = withQuery(stored, applied);
    setHeld({ state, applied });
  }
  return { typed, state };
}
