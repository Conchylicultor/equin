import { useCallback, useState } from "react";

declare const stable: unique symbol;

/**
 * A per-view getter whose result keeps its identity until THAT view's inputs
 * change. Consumers memoise on what it returns (`useLiveSource`'s `state`, the
 * body's memos), and a value minted per call busts every one of them each
 * render — a silent cost, and a #301 render loop once it meets a render-phase
 * `setState` keyed on identity. The brand makes "stable" a type: the only way
 * to mint one is `useViewGetter`, and each model that exposes getters
 * (`ViewActionsCore`, data-view's `ReadyViewModel`) asserts every one is one
 * via `AssertStableGetters`.
 */
export type ViewGetter<T> = ((id: string) => T) & { readonly [stable]: true };

interface Entry {
  inputs: readonly unknown[];
  value: unknown;
}

/** Last inputs + derived value per view id. A class so the read-through write
 *  is a method call, invisible to the React Compiler as a render mutation —
 *  storing it is idempotent, so a discarded concurrent render is harmless. */
class ViewGetterCache {
  private readonly entries = new Map<string, Entry>();

  get<I extends readonly unknown[], T>(
    id: string,
    inputs: I,
    derive: (...inputs: I) => T,
  ): T {
    const hit = this.entries.get(id);
    if (hit !== undefined && sameInputs(hit.inputs, inputs)) {
      return hit.value as T;
    }
    const value = derive(...inputs);
    this.entries.set(id, { inputs, value });
    return value;
  }
}

function sameInputs(a: readonly unknown[], b: readonly unknown[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return false;
  return true;
}

/**
 * Mint a `ViewGetter`. `inputsFor(id)` names the raw, already-stable slots the
 * value derives from (stored config value, stored ephemeral blob, a primitive),
 * compared by identity element-wise; `derive` runs only when one of them
 * changed for that id. The getter's own identity follows `inputsFor`/`derive`,
 * but the values it returns stay put across those changes — that is the
 * contract.
 */
export function useViewGetter<I extends readonly unknown[], T>(
  inputsFor: (id: string) => I,
  derive: (...inputs: I) => T,
): ViewGetter<T> {
  const [cache] = useState(() => new ViewGetterCache());
  const get = useCallback(
    (id: string): T => cache.get(id, inputsFor(id), derive),
    [cache, inputsFor, derive],
  );
  return get as ViewGetter<T>;
}

/**
 * The keys of `M` that are value-returning functions but not `ViewGetter`s —
 * i.e. getters that may mint per call. Setters (returning `void`) and
 * non-function members are excluded.
 */
export type UnstableGetters<M> = {
  [K in keyof M]: M[K] extends (...args: never[]) => infer R
    ? [R] extends [void]
      ? never
      : M[K] extends ViewGetter<unknown>
        ? never
        : K
    : never;
}[keyof M];

/**
 * `true` when every value-returning member of `M` is a `ViewGetter`, else a
 * tuple naming the offenders — so a model states its stability contract in one
 * line: `export const x: AssertStableGetters<Model> = true;` fails tsc the day
 * someone adds a `fooFor: (id) => Foo` that mints per call.
 */
export type AssertStableGetters<M> = [UnstableGetters<M>] extends [never]
  ? true
  : ["getters that are not ViewGetters:", UnstableGetters<M>];
