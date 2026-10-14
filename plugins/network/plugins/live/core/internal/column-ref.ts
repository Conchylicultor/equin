import type { FilterDomainId } from "@plugins/network/plugins/live/plugins/filter/core";
import type { LiveColumnsDeclaration, LiveColumnsOwner } from "./live-columns";

/**
 * Who a column ref's column belongs to: the collection's OWN column, or a
 * column set's (its handle's owner). Readers switch on it exhaustively.
 */
export type LiveColumnRefOwner =
  { readonly kind: "own"; readonly collection: string } | LiveColumnsOwner;

// The mark `mintColumnRef` puts on a ref. Module-private, so no code outside
// this file can write the property — a ref literal is a tsc error.
declare const MINTED: unique symbol;

/** The fields of a column ref, before it is minted (see `mintColumnRef`). */
interface ColumnRefFields {
  /**
   * Whose column it is — the collection's own (by key), an arm's (by its
   * collection's key), an exposure's (by its entity), or a scoped set's member (by the scope it
   * binds under, a collection's `columnScope`).
   */
  readonly owner: LiveColumnRefOwner;
  /** The column's wire name (a column set's is `<set>.<field>`). */
  readonly name: string;
  readonly domain: FilterDomainId | null;
  readonly sortable: boolean;
  /** The column set's handle that declared it; absent for the collection's own column. */
  readonly handle?: LiveColumnsDeclaration;
}

/**
 * One column of a collection as a list binds a field to it: its wire name, the
 * filter domain it takes (`null` when it is not filterable) and whether it
 * sorts. Minted only by `c.column(name)` (or a column set's `.column()`) — a brand only `mintColumnRef` sets, so a hand-written literal,
 * whose `domain` / `sortable` nothing checked, is a tsc error — typed to the
 * declared filterable ∪ sortable names, and carrying its collection's key as
 * data, so a surface reading another collection can tell (a DataView asserts
 * it at mount).
 */
export interface LiveColumnRef extends ColumnRefFields {
  readonly [MINTED]: true;
}

/** Mint a column ref — for the declarations in this folder only (not on the barrel). */
export function mintColumnRef(fields: ColumnRefFields): LiveColumnRef {
  return fields as LiveColumnRef;
}
