import type {
  FullRoute,
  ResourceParams,
  RoutePlan,
  TupleUse,
} from "@plugins/framework/plugins/resource-runtime/core";
import type { PgColumn } from "drizzle-orm/pg-core";
import { canonicalTextOf } from "./canonical-text";
import { canonicalSqlType } from "./raw-sql";
import { BASE_ROUTE_ID } from "./routes";

// A FOLLOW: a computed value (network/live's `serveValue` with `follows`)
// reading one tuple of a collection — its `:rows` point set (`{ ids }`) or a
// scoped `all` set (`{ where }`) — through that collection's own read. The
// collection's compile minted the plan its SQL is routed by; a follow COPIES
// it into the follower's reach plan, so the follower is reached exactly by
// the writes that can move the rows it reads:
//
// - every route keeps the collection's column gate (`columns`, its static
//   `rows`) — a write to a column the collection does not read skips it;
// - every route maps `full` (the follower is a value: no host ids to refill),
//   tagged `via` the follow (resource-runtime's `RouteVia`), so the drift
//   guard never covers the table by the follower's own capture — the
//   collection's read runs in the collection's own loader span;
// - each follower tuple's uses are the collection tuple's own
//   (`plan.usesOf` of the tuple it follows), with the base route's `match`
//   narrowing it to that tuple's rows: the identity column for `{ ids }` (each
//   id admitted only as the column's canonical text, the spelling the feed
//   carries it in — `canonical-text.ts`), the scope columns (the compile's own
//   `scopeOf` match) for `{ where }`. The
//   change feed carries a match column old ∪ new, so a re-pointed row reaches
//   both the tuple it left and the one it joined;
// - a join's far side has no tuple column: it stays gated, with no match.
//
// The compile that minted the plan mints the FOLLOWABLE (`followablePoint`,
// `followableScope`) beside it — the collection's own plan, identity and
// scope, never restated — and `followRead` is the only way to copy one.

const FOLLOWABLE: unique symbol = Symbol("query-resource.followable");
const FOLLOW_READ: unique symbol = Symbol("query-resource.follow-read");

/** A collection tuple a follow reads: a `:rows` id set, or a scoped `all` set's scope. */
export type FollowTuple =
  | { readonly ids: readonly string[] }
  | { readonly where: Readonly<Record<string, string>> };

/**
 * A compiled collection read a follow may copy (see the header): the plan its
 * SQL is routed by, the column a `{ ids }` tuple matches on or the scope a
 * `{ where }` tuple matches on, and how a follow tuple becomes the
 * collection's own params. Minted only by the compiler beside the plan.
 */
export type FollowablePlan =
  | (FollowableBase<{ readonly ids: readonly string[] }> & {
      readonly form: "ids";
      /** The base identity column (`point.by`): an `{ ids }` tuple's match. */
      readonly identity: string;
      /**
       * The identity column's type when its text has no one spelling (a
       * timestamp, a float) — no `{ ids }` tuple can match the feed's key
       * then, so `followRead` refuses the follow — else `null`.
       */
      readonly unmatchableType: string | null;
    })
  | (FollowableBase<{ readonly where: Readonly<Record<string, string>> }> & {
      readonly form: "where";
      /** Each `by` field and its base column: a `{ where }` tuple's match. */
      readonly scope: readonly { field: string; column: string }[];
    });

interface FollowableBase<T extends FollowTuple> {
  /** The collection resource's key. */
  readonly collection: string;
  /** The collection resource's minted plan. */
  readonly plan: RoutePlan<ResourceParams>;
  /**
   * The collection's params for a follow tuple — its point codec's encode,
   * or the scope itself, checked by the resource's own server gate (a scope
   * value the column's text cannot equal is refused, never routed wrong).
   */
  readonly paramsOf: (tuple: T) => ResourceParams;
  readonly [FOLLOWABLE]: true;
}

/** Mint a `:rows` point set's followable — `compile-window`'s and `compile-alias`'s point halves only. */
export function followablePoint(
  collection: string,
  plan: RoutePlan<ResourceParams>,
  identity: PgColumn,
  encode: (ids: readonly string[]) => ResourceParams,
): FollowablePlan {
  const sqlType = canonicalSqlType(identity.getSQLType());
  const canonical = canonicalTextOf(sqlType);
  return {
    form: "ids",
    collection,
    plan,
    identity: identity.name,
    unmatchableType: canonical === null ? sqlType : null,
    // An id the column's text cannot equal would match no change for good
    // (the point read casts it and finds the row): refused, never routed.
    paramsOf: ({ ids }) => {
      for (const id of ids) {
        const expected = canonical?.(id) ?? null;
        if (expected !== null) {
          throw new Error(
            `follow of "${collection}": id ${JSON.stringify(id)} must be ${expected} — the follow matches the id as the change feed's text of "${identity.name}".`,
          );
        }
      }
      return encode(ids);
    },
    [FOLLOWABLE]: true,
  };
}

/** Mint a scoped `all` set's followable — `compile-alias` only. */
export function followableScope(
  collection: string,
  plan: RoutePlan<ResourceParams>,
  scope: readonly { field: string; column: string }[],
  check: (params: ResourceParams) => void,
): FollowablePlan {
  if (scope.length === 0) {
    throw new Error(
      `followableScope("${collection}"): an unscoped \`all\` set has no tuple to follow by \`where\` — follow its rows by \`ids\`.`,
    );
  }
  return {
    form: "where",
    collection,
    plan,
    scope,
    paramsOf: ({ where }) => {
      check(where);
      return where;
    },
    [FOLLOWABLE]: true,
  };
}

/**
 * What a follow reads for a follower keyed by `P`, for its reach plan
 * (`compiledValueReach`'s `follows`): the collection's routes, copied (see
 * the header), and which of them each follower tuple reads. Minted by
 * `followRead` only.
 */
export interface FollowRead<P extends ResourceParams = ResourceParams> {
  /** The follow's name — its routes' id prefix and their `via`. */
  readonly name: string;
  /** The followed collection resource's key. */
  readonly collection: string;
  readonly routes: readonly FullRoute[];
  /** The routes `params` reads: none for an empty `{ ids }` tuple. */
  readonly usesOf: (params: P) => ReadonlyMap<string, TupleUse>;
  readonly [FOLLOW_READ]: true;
}

/** Whether `read` came from `followRead` (not a cast literal). */
export function isFollowRead(read: object): read is FollowRead<never> {
  return (read as Partial<FollowRead>)[FOLLOW_READ] === true;
}

/** Whether `plan` was minted by a collection compile (not a cast literal). */
export function isFollowable(plan: object): plan is FollowablePlan {
  return (plan as Partial<FollowablePlan>)[FOLLOWABLE] === true;
}

/**
 * Copy `followable`'s plan into a follower's reach (see the header): the
 * follow `name` reads, for a follower tuple `params`, the collection tuple
 * `tupleOf(params)` — its form (`ids` / `where`) the followable's own. A
 * `tupleOf` that throws, or answers the other form, is reported by the
 * runtime and FULLs that follower tuple.
 */
export function followRead<P extends ResourceParams>(
  followable: FollowablePlan,
  name: string,
  tupleOf: (params: P) => FollowTuple,
): FollowRead<P> {
  if (!isFollowable(followable)) {
    throw new Error(
      `followRead("${name}"): the target was not minted by a collection compile — a follow copies the routes its collection's SQL is routed by, so only that compile may state them.`,
    );
  }
  const { collection, plan } = followable;
  const where = `followRead("${name}" of "${collection}")`;
  if (followable.form === "ids" && followable.unmatchableType !== null) {
    throw new Error(
      `${where}: the id column "${followable.identity}" is a ${followable.unmatchableType} — a follow by \`ids\` matches an id as the change feed's text of it, which has no one spelling for that type. Follow a collection keyed by text, uuid or an integer.`,
    );
  }
  const reason = `the follow "${name}" of "${collection}" re-reads its follower whole: a computed value has no host ids to refill`;
  const base = plan.routes.find((r) => r.id === BASE_ROUTE_ID);
  if (base === undefined) {
    throw new Error(
      `${where}: the collection's plan has no base route — a followed read is one base table's rows.`,
    );
  }
  const baseMatch =
    followable.form === "ids"
      ? [followable.identity]
      : followable.scope.map((s) => s.column);
  const idOf = (routeId: string) => `${name}:${routeId}`;
  const routes: FullRoute[] = plan.routes.map((route) => {
    const match =
      route.id === BASE_ROUTE_ID
        ? [...new Set([...(route.match ?? []), ...baseMatch])]
        : route.match;
    return {
      id: idOf(route.id),
      table: route.table,
      map: { kind: "full", reason },
      columns: route.columns,
      ...(route.rows !== undefined ? { rows: route.rows } : {}),
      ...(match !== undefined && match.length > 0 ? { match } : {}),
      via: { name, collection },
    };
  });
  const none: ReadonlyMap<string, TupleUse> = new Map();
  // The collection tuple's own uses, re-keyed: the base narrowed to the
  // tuple's rows — its ids on the identity, or its scope (already the base
  // use's own match). Every route is `full`, so a use's role and `moves`
  // decide nothing; the roles are kept as the collection states them.
  const copied = (
    collectionParams: ResourceParams,
    baseNarrow: Readonly<Record<string, ReadonlySet<string>>>,
  ): ReadonlyMap<string, TupleUse> =>
    new Map(
      [...plan.usesOf(collectionParams)].map(([id, use]) => {
        const match =
          id === BASE_ROUTE_ID ? { ...use.match, ...baseNarrow } : use.match;
        const copy: TupleUse = {
          role: use.role,
          ...(match !== undefined ? { match } : {}),
        };
        return [idOf(id), copy];
      }),
    );
  const usesOf = (params: P): ReadonlyMap<string, TupleUse> => {
    const tuple = tupleOf(params);
    if (followable.form === "ids") {
      if (!("ids" in tuple)) {
        throw new Error(
          `${where}: the tuple is ${JSON.stringify(tuple)}, not \`{ ids }\` — the collection's \`:rows\` is followed by id.`,
        );
      }
      if (tuple.ids.length === 0) return none;
      return copied(followable.paramsOf(tuple), {
        [followable.identity]: new Set(tuple.ids),
      });
    }
    if (!("where" in tuple)) {
      throw new Error(
        `${where}: the tuple is ${JSON.stringify(tuple)}, not \`{ where }\` — a scoped \`all\` set is followed by its scope.`,
      );
    }
    return copied(followable.paramsOf(tuple), {});
  };
  return {
    name,
    collection,
    routes,
    usesOf,
    [FOLLOW_READ]: true,
  };
}
