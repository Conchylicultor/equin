// Which resource tuple an optimistic read (or a lane-only write) names — the
// ONE derivation of `(descriptor, params)` from the declaration-and-query pair
// a caller writes. `useOptimisticResource`, `enqueueResourceWrite` and
// `enqueueDetachedWrite` all resolve through it, so the tuple a hook reads, the
// send lane it dispatches on and the lane a detached write joins cannot be
// derived two different ways: a page's detached write and its mounted overlay
// meet on one lane by construction.

import type { ResourceDescriptor } from "@plugins/primitives/plugins/live-state/core";
import { canonicalParams } from "@plugins/packages/plugins/canonical-params/core";
import type {
  LiveAllCollection,
  LiveRowsCollection,
} from "@plugins/network/plugins/live/core";

/** The `{ ids }` read of a collection — its `:rows` point sibling. */
export interface OptimisticIdsQuery {
  ids: readonly string[];
}

/**
 * One scope of a collection declared `all: { by }` — exactly its `by`
 * fields, each a string (the record IS the tuple's params), as
 * `useLive(c, { where })` reads it. `never` for a set declared without `by`,
 * which has one tuple and is read through its `{ ids }` sibling here.
 */
export type OptimisticScopedQuery<B extends string> = [B] extends [never]
  ? never
  : { where: { readonly [K in B]: string } };

/** A resolved read: the descriptor and its canonical params tuple. */
export interface OptimisticSource<Data> {
  resource: ResourceDescriptor<Data, Record<string, string>>;
  /** Canonical (`canonicalParams`) — `undefined` for a param-less value. */
  params: Record<string, string> | undefined;
}

/**
 * Resolve a declaration and its query to the tuple it names:
 *
 * - a `liveValue` and its params (absent for a param-less value);
 * - a collection and `{ ids }` — its `:rows` point sibling at the canonical
 *   encoding of the id set (rows unordered);
 * - a collection declared `all: { by }` and `{ where }` — its `key` at that
 *   scope, the rows in the declared order (the `where` record is the tuple).
 *
 * The params come back canonical, so every key derived from them — the
 * subscription, the send lane, the tx-ack and watermark namespaces — names
 * the tuple the server echoes. Throws for what the overloads forbid an
 * untyped caller: a query that is neither form, `{ where }` on a set declared
 * without `by` (or on no `all` set), and a scope that is not exactly the `by`
 * fields (the descriptor's own params gate).
 */
export function resolveOptimisticSource<Data>(
  source: object,
  query: object | undefined,
): OptimisticSource<Data> {
  if ("live" in source) {
    const resource = source as unknown as ResourceDescriptor<
      Data,
      Record<string, string>
    >;
    return {
      resource,
      params:
        query === undefined
          ? undefined
          : canonicalParams(
              query as Record<string, string>,
              resource.optionalParams,
            ),
    };
  }
  const collection = source as LiveRowsCollection<unknown> & {
    all?: LiveAllCollection<unknown, string>["all"] | undefined;
  };
  if (query !== undefined && "ids" in query) {
    const rows = collection.rows;
    return {
      resource: rows as unknown as ResourceDescriptor<
        Data,
        Record<string, string>
      >,
      params: rows.point.encode((query as OptimisticIdsQuery).ids),
    };
  }
  if (query !== undefined && "where" in query) {
    const all = collection.all;
    if (
      all === undefined ||
      (all.all as { by?: readonly string[] }).by === undefined
    ) {
      throw new Error(
        `optimistic-mutation: \`{ where }\` on "${collection.key}", which is not declared \`all: { by }\` — only a scoped set is read by its scope (an id set is \`{ ids }\`).`,
      );
    }
    const where = (query as { where: Record<string, string> }).where;
    // The descriptor's gate: exactly the `by` fields, each a non-empty string
    // — here, at the call site, rather than as a refused subscription (or, for
    // a lane-only write, never).
    all.validateParams(where);
    return {
      resource: all as unknown as ResourceDescriptor<
        Data,
        Record<string, string>
      >,
      params: canonicalParams(where, all.optionalParams),
    };
  }
  throw new Error(
    `optimistic-mutation: "${collection.key}" is read by \`{ ids }\` or, declared \`all: { by }\`, by \`{ where }\` — got ${JSON.stringify(query)}.`,
  );
}
