import type {
  LiveKeyCut,
  LiveKeyRange,
  LivePagedPages,
  LiveValueOrigin,
} from "@plugins/network/plugins/live/core";
import { pageRowsOf } from "../../core/internal/compile-value";
import { compareRowKeys, sliceRange } from "../../core/internal/key-order";

// A paged value's source against its contract, for the source's own suite:
// every range a reader can ask — each cut a row key the source holds or held,
// `null` at either end, at each limit — is answered exactly as `sliceRange`
// answers it over the source's whole list, and passes the checks the served
// half runs on every answer (`pageRowsOf`: key arity, strictly ascending,
// inside the range, at most the limit). A cut is a POSITION: pass the cuts of
// rows the source no longer holds in `cuts`, and each must still bound its
// ranges as if the row were there.

/** What `checkPagedSource` checks: the declaration, the question, the loader and the truth. */
export interface PagedSourceCheck<Item, Q> {
  value: LivePagedPages<Item, Q, unknown, LiveValueOrigin>;
  /** The DECODED question the loader is asked. */
  query: Q;
  loader: (
    query: Q,
    range: LiveKeyRange,
  ) => readonly Item[] | Promise<readonly Item[]>;
  /** Every item the source holds for `query` right now, in any order. */
  items: readonly Item[];
  /** More positions to cut at — the keys of items since deleted, say. */
  cuts?: readonly LiveKeyCut[];
  /** The limits each range is asked at. Default: 1, and the declared `limit`. */
  limits?: readonly number[];
}

/**
 * Ask `loader` every range over the items' and `cuts`' keys and throw — naming
 * the range, the answer and the expected ids — on the first answer that
 * differs from `sliceRange` or fails the served half's checks.
 */
export async function checkPagedSource<Item, Q>(
  check: PagedSourceCheck<Item, Q>,
): Promise<void> {
  const { value, query, loader, items } = check;
  const { id, key } = value.paged;
  const keyOf = (item: Item): LiveKeyCut => ({
    key: key.of(item),
    id: (item as Record<string, unknown>)[id] as string,
  });
  const cuts = [...items.map(keyOf), ...(check.cuts ?? [])].sort((a, b) =>
    compareRowKeys([...a.key, a.id], [...b.key, b.id], key.order),
  );
  const bounds: (LiveKeyCut | null)[] = [null, ...cuts];
  const limits = check.limits ?? [1, value.paged.limit];
  for (const limit of limits) {
    for (let a = 0; a < bounds.length; a++) {
      // `until` after `after` (or the order's end).
      for (const until of [...bounds.slice(a + 1), null]) {
        const range: LiveKeyRange = { after: bounds[a]!, until, limit };
        const answer = await loader(query, range);
        const rows = pageRowsOf(value, range, answer);
        const got = rows.map((r) => r[id] as string);
        const want = sliceRange(value, items, range).map(
          (item) => (item as Record<string, unknown>)[id] as string,
        );
        if (JSON.stringify(got) !== JSON.stringify(want)) {
          throw new Error(
            `checkPagedSource("${value.key}"): the range ${JSON.stringify(range)} ` +
              `answered ${JSON.stringify(got)}, expected ${JSON.stringify(want)}.`,
          );
        }
      }
    }
  }
}
