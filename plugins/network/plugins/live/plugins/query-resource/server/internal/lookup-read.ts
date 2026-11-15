import type {
  FullRoute,
  ResourceParams,
  TupleUse,
} from "@plugins/network/plugins/live/plugins/resource-runtime/core";

// A compiled lookup's read, on its own: `routes.ts` folds lookups into a
// value's reach and checks their brand, and it is in the closure the
// `liveReadCode` digest covers — so it reads the brand here, never through
// `./compile-lookup`, whose query runs on the real database (a lookup is a
// hand-written value's read, nothing a handed-over tuple or an L2 row
// depends on).

// The mark a compiled lookup puts on a read. Private to this plugin (no barrel names it), so a
// `LookupRead` cannot be spelled as a literal: its routes' columns gate
// updates, so only the code that renders the SQL may state them.
export const LOOKUP_READ: unique symbol = Symbol("query-resource.lookup-read");

/**
 * What a compiled lookup reads for a reader keyed by `P`, for a served value's
 * `reads.lookups` (`compiledValueReach`): its routes — one `full` route per
 * relation, gated by the columns its SQL reads, the key table's matched per
 * tuple — and which of them each tuple reads. Minted by
 * `CompiledLookup.read` only.
 */
export interface LookupRead<P extends ResourceParams = ResourceParams> {
  /** The lookup's label — its read tag, and the prefix of its route ids. */
  readonly label: string;
  /** Every relation its SQL reads, as a `full` route (ids `<label>:<relation>`). */
  readonly routes: readonly FullRoute[];
  /** The routes `params` reads: none when the tuple names no key. */
  readonly usesOf: (params: P) => ReadonlyMap<string, TupleUse>;
  readonly [LOOKUP_READ]: true;
}

/** Whether `read` came from a compiled lookup (not a cast literal). */
export function isLookupRead(read: object): read is LookupRead<never> {
  return (read as Partial<LookupRead>)[LOOKUP_READ] === true;
}
