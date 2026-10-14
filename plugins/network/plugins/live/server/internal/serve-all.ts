import { getTableColumns, type SQL } from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
import type { ZodParser } from "@plugins/packages/plugins/zod-parser/core";
import { columnWireCodec } from "@plugins/database/plugins/sql-column/server";
import {
  BASE_RELATION,
  isExprField,
  type AggregateRef,
  type AllJoinRefs,
  type AllJoinSpec,
  type ColumnRef,
  type ExprField,
  type JoinRef,
  type JoinSpec,
  type RollupJoin,
} from "@plugins/infra/plugins/query-resource/core";
import {
  compileAllCollection,
  type AllBind,
  type CompiledAllCollection,
  type QueryDb,
  type ReadColumn,
  type SelectMap,
} from "@plugins/infra/plugins/query-resource/server";
import {
  LIVE_COLUMNS_KEY,
  type LiveAllCollection,
} from "@plugins/network/plugins/live/core";
import { exposedBinding, exposureFolds } from "./exposure-folds";
import type { ExposingExtension } from "./serve-columns";
import {
  isEntitySource,
  type CollectionSource,
  type ColumnsOf,
  type TableOf,
  type WireCheck,
} from "./collection-source";

// The `all` arm of `serveCollection` (P8 v3 step 16b.6, C4): a collection
// declared `liveCollection(key, { all })` — every row, in one declared order —
// bound to its table the way a window collection is (row fields by property
// name, overrides in `columns`, a base `where`), and compiled by
// query-resource's `compileAllCollection` into its two resources: `key` (the
// whole ordered set, a routed `scopedMembership` alias the runtime keeps
// current and L2 persists) and `key:rows` (the point sibling). It is never
// scoped or a union: those paths compile at boot from other
// plugins' contributions, while an `all` collection's definition (A18) is
// fixed at module eval. The one exception is its `exposes`: the exposures it
// reaches (`LiveColumns.Expose`) are folded at boot (`serveCollection` defers
// both halves), and the fold is part of the definition — the joins and
// projections move the SQL, and `wire.ids` names the folded fields.

/** A field bound to a column of the base, a row-wise join or a rollup — never an aggregate. */
type ColumnBinding<Refs> = Exclude<
  JoinRef<Refs>,
  { readonly aggregate: string }
>;

/**
 * A value as JSON carries it: a `Date` is its ISO string, recursively through
 * arrays and objects — what the socket sends for a field of type `T`.
 */
type JsonForm<T> = T extends Date
  ? string
  : T extends readonly (infer E)[]
    ? JsonForm<E>[]
    : T extends object
      ? { [K in keyof T]: JsonForm<T[K]> }
      : T;

/**
 * How one row field of an `all` collection binds, over `j` (`AllJoinRefs`):
 * a column ref (the base's, a row-wise join's or a rollup's wire columns), an
 * aggregate ref of a children / closure join (`j.<alias>.<aggregate>`), or an
 * expression over any of them (`expr`). An aggregate's and an expression's
 * value type must be the row field's (tsc), `| null` unless declared not-null.
 *
 * A `jsonAgg` aggregate (form `json`) holds the field's JSON form
 * (`JsonForm`) instead: it hands its elements back as the JSON the driver
 * parsed — a `timestamptz` as the ISO text the compiler rendered, never
 * decoded to a `Date` — which is byte for byte what the wire would make of
 * the decoded value, so decoding it only to re-encode it would be wasted
 * work. The client parses the field with the row schema either way. A scalar
 * `aggregate` (form `decoded`) must hold exactly `V`: its text form of a
 * `timestamptz` is Postgres's, not ISO, so the JSON form is no proof for it.
 */
type AllFieldBinding<
  T extends CollectionSource,
  J extends readonly AllJoinSpec[],
  V,
> = (
  j: AllJoinRefs<ColumnsOf<T>, J>,
) =>
  | ColumnBinding<AllJoinRefs<ColumnsOf<T>, J>>
  | AggregateRef<string, string, V, "decoded">
  | AggregateRef<string, string, JsonForm<V>, "json">
  | ExprField<V>;

/** `columns`, optional while every row field is a column of `from` by name (as `serveCollection`'s). */
type AllColumnOverrides<
  T extends CollectionSource,
  Row,
  N extends string & keyof Row,
  J extends readonly AllJoinSpec[],
> = [Exclude<N, keyof ColumnsOf<T> & string>] extends [never]
  ? { columns?: { [K in N]?: AllFieldBinding<T, J, Row[K]> } }
  : {
      columns: { [K in N]?: AllFieldBinding<T, J, Row[K]> } & {
        [K in Exclude<N, keyof ColumnsOf<T> & string>]: AllFieldBinding<
          T,
          J,
          Row[K]
        >;
      };
    };

/**
 * What a static `where` of an `all` collection is written with: the base's
 * and each ROW-WISE join's raw columns (a window join's table, a rollup's
 * handle), rendered against their relation — never a children or closure
 * join's, whose rows reach the row only through aggregates (A29).
 */
export type AllWhereColumns<
  Base extends PgTable,
  J extends readonly AllJoinSpec[],
> = { readonly base: Base["_"]["columns"] } & {
  readonly [
    S in J[number] as S extends JoinSpec | RollupJoin ? S["alias"] : never
  ]: S extends JoinSpec
    ? S["table"]["_"]["columns"]
    : S extends RollupJoin
      ? S["rollup"]["handle"]["_"]["columns"]
      : never;
};

export type ServeAllCollectionOptions<
  T extends CollectionSource,
  Row,
  J extends readonly AllJoinSpec[] = readonly [],
> = {
  from: T;
  /**
   * Row-wise joins (extension, lookup — required INNER included —, keyed
   * side, rollup) and grouped ones (`childrenJoin`, `closureJoin`), as
   * query-resource's `AllJoinSpec` (see its CLAUDE.md, *The `all` compiler*).
   */
  joins?: J;
  /**
   * The base membership: the set IS the rows matching it. Static — over the
   * base's and the row-wise joins' columns, never an aggregate (A29). A flip
   * of a column it reads is an exit or an entrant.
   */
  where?: SQL | ((j: AllWhereColumns<TableOf<T>, J>) => SQL);
  /**
   * At most one flush of the whole set per window (ms) — the first change
   * arms a trailing timer later changes do not re-arm (the runtime's
   * `debounceMs`, as `serveValue`'s `throttleMs`; C18).
   */
  throttleMs?: number;
  /** Test seam. Defaults to the real per-worktree drizzle `db`. */
  db?: QueryDb;
} & AllColumnOverrides<
  T,
  Row,
  // `$columns` is folded (an exposing set's exposures), never bound.
  Exclude<keyof Row & string, typeof LIVE_COLUMNS_KEY>,
  J
> &
  WireCheck<T, Row>;

/** An `all` collection's compiled server halves (query-resource's `CompiledAllCollection`). */
export type AllCollectionSpecs<Row> = CompiledAllCollection<Row>;

function isAggregateRef(
  binding: unknown,
): binding is AggregateRef<string, string, unknown> {
  return (
    typeof binding === "object" &&
    binding !== null &&
    typeof (binding as { aggregate?: unknown }).aggregate === "string"
  );
}

/**
 * Derive an `all` collection's two server halves — `all` (the whole ordered
 * set) and `rows` — without registering them. Every binding miss throws here,
 * at module eval, beside every refusal `compileAllCollection` makes.
 */
export function compileAllSpecs<Row>(
  collection: LiveAllCollection<Row>,
  opts: ServeAllCollectionOptions<
    CollectionSource,
    Row,
    readonly AllJoinSpec[]
  >,
  exposed: readonly ExposingExtension[] = [],
): AllCollectionSpecs<Row> {
  const fail = (message: string): never => {
    throw new Error(`serveCollection("${collection.key}"): ${message}`);
  };
  // C4 — typed away (`LiveAllCollection` has no such field); refused against
  // a cast: scoped columns compile at boot from contributions,
  // and a union reads several tables; an `all` set is one table's, compiled
  // here once.
  const cast = collection as unknown as {
    columnScope?: unknown;
    arms?: unknown;
  };
  if ((cast.columnScope ?? null) !== null) {
    fail(
      "a collection declared `all` cannot be `columnScope`d — its definition (the L2 fingerprint) is fixed at module eval, never folded from contributions at boot.",
    );
  }
  if ((cast.arms ?? null) !== null) {
    fail(
      "a collection declared `all` is never a union (`arms`) — it is one table's whole ordered set.",
    );
  }
  const from: CollectionSource = opts.from;
  const table = isEntitySource(from) ? from.table : from;
  // An entity binds through its WIRE columns, never a server-only column.
  const sourceColumns: Record<string, PgColumn> = isEntitySource(from)
    ? from.wireColumns
    : (getTableColumns(table) as Record<string, PgColumn>);
  const overrides = (opts.columns ?? {}) as Record<
    string,
    ((j: unknown) => unknown) | undefined
  >;
  // The exposures its `exposes` reaches (`./exposure-folds`), each joined
  // under its slice and projected flat under its wire names, then folded into
  // `$columns[<slice>]` by `wire.encodeRow`.
  const exposes = collection.exposes ?? null;
  const folds = exposureFolds(
    exposes,
    table,
    opts.joins ?? [],
    exposed,
    { fields: collection.rowKeys, sets: [] },
    fail,
  );
  const exposedFields = new Map<
    string,
    { slice: string; field: string; schema: unknown }
  >();
  for (const { handle } of folds) {
    for (const field of handle.fields) {
      exposedFields.set(handle.wireName(field), {
        slice: handle.name,
        field,
        schema: handle.rowShape[field],
      });
    }
  }
  const rowShape = collection.row.shape as Readonly<Record<string, unknown>>;
  const fieldSchema = (name: string): ZodParser<unknown> => {
    const schema = (exposedFields.get(name)?.schema ?? rowShape[name]) as
      Partial<ZodParser<unknown>> | undefined;
    if (typeof schema?.safeParse !== "function") {
      return fail(`row schema field "${name}" is not a zod schema.`);
    }
    return schema as ZodParser<unknown>;
  };
  // A wire codec's `encode` is code the L2 definition cannot read (A18): a
  // change to it would serve rows persisted under the old encoding as current.
  // No `all` collection needs one, so it is refused rather than fingerprinted
  // by a name nothing keeps honest.
  const wireRefused = (name: string): never =>
    fail(
      `row field "${name}" reads a wire-encoded value (sql-column \`withWire\`, or an expression's \`wire\`) — an \`all\` collection is L2-persisted and its definition cannot read an encoder's code, so a wire form is not served here.`,
    );

  const select = (bind: AllBind): SelectMap => {
    const j = bind.j as unknown as Record<
      string,
      Readonly<Record<string, unknown>> | undefined
    >;
    const out: SelectMap = {};
    // An exposed field binds to its own join's column of the same name — the
    // presence field to the expression over the join's key.
    const exposedRefs = folds.flatMap((fold) =>
      fold.handle.fields.map(
        (field) =>
          [
            fold.handle.wireName(field),
            exposedBinding(fold, field, j[fold.join.alias], fail),
          ] as const,
      ),
    );
    for (const name of [
      ...collection.rowKeys,
      ...exposedRefs.map(([wire]) => wire),
    ]) {
      const exposedRef = exposedRefs.find(([wire]) => wire === name)?.[1];
      const override = overrides[name];
      const sourceCol = sourceColumns[name];
      const binding: unknown = exposedRef
        ? exposedRef
        : override
          ? override(bind.j)
          : sourceCol
            ? ({ from: BASE_RELATION, col: sourceCol } satisfies ColumnRef)
            : fail(
                `row field "${name}" binds to no column of the source — pass it in \`columns\`.`,
              );
      let read: ReadColumn;
      if (isExprField(binding)) {
        if (binding.wire !== undefined) wireRefused(name);
        read = bind.expr(binding, name) as ReadColumn;
      } else if (isAggregateRef(binding)) {
        read = bind.aggregate(binding) as ReadColumn;
      } else {
        const ref = binding as ColumnRef;
        // A ref `j` did not offer: a server-only column (the types stop a
        // literal `j` never made; this stops a cast).
        const offered = Object.values(j[ref.from] ?? {}).some(
          (r) => (r as { col?: unknown }).col === ref.col,
        );
        if (!offered) {
          fail(
            `row field "${name}" binds to "${ref.from}"."${ref.col.name}", which is not a wire column of that relation — a server-only column never reaches the wire.`,
          );
        }
        if (columnWireCodec(ref.col) !== undefined) wireRefused(name);
        read = bind.render(ref);
      }
      // The runtime backstop of the binding's type (as `serveCollection`'s
      // window path): a computed read that may be NULL, or a column read
      // through a LEFT join, must land on a field that accepts null — else the
      // first such row fails the payload parse at load time.
      const mayBeNull = bind.plan.isComputed(read)
        ? bind.plan.canBeNull(read)
        : bind.plan.outer(bind.plan.relationOf(read)) &&
          bind.plan.canBeNull(read);
      if (mayBeNull && !fieldSchema(name).safeParse(null).success) {
        fail(
          `row field "${name}" may read NULL (a computed read that is not declared not-null, or a column read through a LEFT join) — make the field nullable.`,
        );
      }
      out[name] = read;
    }
    return out;
  };
  const where = opts.where;
  const joins: readonly AllJoinSpec[] = [
    ...(opts.joins ?? []),
    ...folds.map((f) => f.join),
  ];
  // The fold: every reached slice under `$columns` (present even with no field
  // projected — the row schema requires the key), each field moved out of its
  // flat wire name. `encodeRow` is code the definition cannot read, so its id
  // names exactly the fields it moves (A18).
  const slices = folds.map((f) => f.handle.name);
  const fold = (row: Record<string, unknown>): Record<string, unknown> => {
    const out = { ...row };
    const cols: Record<string, Record<string, unknown>> = Object.fromEntries(
      slices.map((slice) => [slice, {}]),
    );
    for (const [wire, { slice, field }] of exposedFields) {
      cols[slice]![field] = out[wire];
      delete out[wire];
    }
    out[LIVE_COLUMNS_KEY] = cols;
    return out;
  };
  const foldId = `exposed:${[...exposedFields.keys()].sort().join(",")}`;
  return compileAllCollection(
    { all: collection.all, rows: collection.rows },
    {
      from: opts.from,
      ...(joins.length > 0 ? { joins } : {}),
      select,
      ...(exposes === null
        ? {}
        : { wire: { encodeRow: fold, ids: { [LIVE_COLUMNS_KEY]: foldId } } }),
      ...(where === undefined
        ? {}
        : {
            where:
              typeof where === "function"
                ? (bind: AllBind) =>
                    where(
                      bind.plan.columns() as unknown as AllWhereColumns<
                        PgTable,
                        readonly AllJoinSpec[]
                      >,
                    )
                : where,
          }),
      ...(opts.throttleMs !== undefined ? { debounceMs: opts.throttleMs } : {}),
      ...(opts.db !== undefined ? { db: opts.db } : {}),
    },
  );
}
