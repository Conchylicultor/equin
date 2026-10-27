import type { ResourceResult } from "@plugins/primitives/plugins/live-state/web";
import type { ViewModel } from "./use-data-view-model";

/** The error arm of a slot-order read, kept whole (its typed error, Retry). */
export type SlotLayoutFailure = Extract<
  ResourceResult<unknown>,
  { status: "error" }
>;

/**
 * A slot's layout as the order to draw by: `known` — the items in layout
 * order; `loading` — not known yet; `failed` — the read failed with no layout
 * ever known (`failure`, the read's own error arm).
 *
 * A failed read that still holds its last-known layout (`stale`) is `known`:
 * that layout is what the user last saw, so it is the honest answer. Loading
 * stays loading — never the raw registration order standing in for a layout
 * not known yet (it would show hidden items, then jump).
 */
export type SlotLayout<T> =
  | { kind: "known"; items: T }
  | { kind: "loading" }
  | { kind: "failed"; failure: SlotLayoutFailure };

const LOADING = { kind: "loading" } as const;

/** Read a `useSlotOrder` result as a {@link SlotLayout}. Pure; `known.items`
 *  keeps the read's own array identity. */
export function slotLayout<T>(result: ResourceResult<T>): SlotLayout<T> {
  switch (result.status) {
    case "loading":
      return LOADING;
    case "error":
      return result.stale !== undefined
        ? { kind: "known", items: result.stale }
        : { kind: "failed", failure: result };
    case "ready":
      return { kind: "known", items: result.data };
  }
}

/** Derive from a known layout's items; loading and failed pass through. */
export function mapLayout<T, U>(
  layout: SlotLayout<T>,
  fn: (items: T) => U,
): SlotLayout<U> {
  return layout.kind === "known"
    ? { kind: "known", items: fn(layout.items) }
    : layout;
}

/**
 * Two layouts that must BOTH be known (the switcher's view types and its
 * sources): failed if either failed (the first), loading if either loads.
 */
export function bothLayouts<A, B>(
  a: SlotLayout<A>,
  b: SlotLayout<B>,
): SlotLayout<{ a: A; b: B }> {
  if (a.kind === "failed") return a;
  if (b.kind === "failed") return b;
  if (a.kind === "loading" || b.kind === "loading") return LOADING;
  return { kind: "known", items: { a: a.items, b: b.items } };
}

/**
 * The shell's not-ready model for a view-type layout that is not known: the
 * skeleton while it loads, the failure (with Retry) when it failed with no
 * layout ever known. The shell renders both — a DataView never builds its
 * view model over an empty contribution list it would then report every
 * configured row of as an orphan.
 */
export function pendingLayoutModel(
  layout: Exclude<SlotLayout<unknown>, { kind: "known" }>,
): Extract<ViewModel, { ready: false }> {
  return layout.kind === "loading"
    ? { ready: false, failure: null }
    : {
        ready: false,
        failure: {
          error: layout.failure.error,
          refetch: layout.failure.refetch,
        },
      };
}
