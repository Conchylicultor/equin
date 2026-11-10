import { useLayoutEffect, useMemo, useReducer } from "react";
import { splitSheetMarkup, type SplitSheetMarkup } from "./sheet-markup";

/*
 * The resources a sheet's symbols reference by `url(#id)` (an active form's
 * masks) are rendered only while an icon draws one of those symbols.
 *
 * A resource must sit in a RENDERED subtree to take effect (under
 * `display: none` a mask hides nothing), so every one in the page is visited
 * by every whole-document style recalc — and a sheet holds hundreds of them
 * (the Lucide active sprite: one pair of masks per symbol, ~2k elements), of
 * which a page draws a handful at a time. So a sheet renders the resources of
 * the symbols in use, not of the symbols it holds: `<Icon>` holds its symbol
 * (`useSheetResources`) while it draws it, and every sheet renders the
 * resources of the held symbols it has.
 */

/** How many mounted icons draw each symbol id. */
const held = new Map<string, number>();
/** Every symbol id some sheet split so far holds resources for. */
const withResources = new Set<string>();
/** Bumped when a symbol with resources starts or stops being held. */
let version = 0;
const listeners = new Set<() => void>();

/**
 * `splitSheetMarkup` for a sheet's render, recording which symbols hold
 * resources (ids only — bounded by the symbols the page ever held), so
 * holding one re-renders the sheets and holding any other does not.
 */
export function useSplitSheet(markups: readonly string[]): SplitSheetMarkup[] {
  return useMemo(
    () =>
      markups.map((markup) => {
        const split = splitSheetMarkup(markup);
        for (const id of split.resources.keys()) withResources.add(id);
        return split;
      }),
    [markups],
  );
}

function hold(id: string): () => void {
  const count = held.get(id) ?? 0;
  held.set(id, count + 1);
  if (count === 0) changed(id);
  return () => {
    const left = held.get(id)! - 1;
    if (left > 0) {
      held.set(id, left);
      return;
    }
    held.delete(id);
    changed(id);
  };
}

function changed(id: string): void {
  if (!withResources.has(id)) return;
  version++;
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Hold symbol `id`'s resources rendered while the caller draws it (`null`:
 * nothing drawn). A layout effect, so a newly drawn symbol's masks are in the
 * page before it paints.
 */
export function useSheetResources(id: string | null): void {
  useLayoutEffect(() => (id === null ? undefined : hold(id)), [id]);
}

/**
 * Re-renders the caller whenever the held resource-bearing symbols change;
 * returns the test for whether a symbol is held now.
 *
 * Subscribed in a LAYOUT effect, not `useSyncExternalStore` (whose
 * subscription is a passive effect): a sheet mounting in the same commit as
 * the icons drawing from it must render their masks before that commit
 * paints, whichever of its and their layout effects runs first.
 */
export function useHeldSymbols(): (id: string) => boolean {
  const [seen, sync] = useReducer((_: number, v: number) => v, version);
  useLayoutEffect(() => {
    const check = () => sync(version);
    check();
    return subscribe(check);
  }, []);
  void seen;
  return isHeld;
}

function isHeld(id: string): boolean {
  return held.has(id);
}
