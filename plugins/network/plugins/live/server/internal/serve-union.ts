import { getTableColumns, getTableName, sql, type SQL } from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
import type { ZodParser } from "@plugins/packages/plugins/zod-parser/core";
import {
  testClause,
  type Filter,
  type FilterClause,
  type Filterable,
  type FilterScalar,
} from "@plugins/network/plugins/live/plugins/filter/core";
import { filterSql } from "@plugins/network/plugins/live/plugins/filter/server";
import {
  defineDeferredResource,
  Resource as ResourceContribution,
} from "@plugins/framework/plugins/server-core/core";
import {
  columnWireCodec,
  type WireCodec,
} from "@plugins/database/plugins/sql-column/server";
import {
  isExprField,
  KIND_RE,
  type ColumnRef,
  type ExprField,
  type JoinSpec,
} from "@plugins/infra/plugins/query-resource/core";
import {
  compileJoins,
  compileUnionCollection,
  joinRefs,
  type CompiledGroups,
  type CompiledUnion,
  type EntitySource,
  type QueryDb,
  type ReadColumn,
  type RoutedSource,
  type UnionArmSpec,
  type UnionColumn,
} from "@plugins/infra/plugins/query-resource/server";
import type { PointParams } from "@plugins/primitives/plugins/live-state/core";
import type { EntityTable } from "@plugins/infra/plugins/entities/server";
import {
  LIVE_COLUMNS_KEY,
  LIVE_ROW_KEY,
  LIVE_ROW_KEY_MAX_BYTES,
  type LiveArmColumnsHandle,
  type LiveArmsCollection,
  type LiveColumnsDeclaration,
  type LiveGroup,
  type LiveGroupParams,
  type LiveWindowParams,
  type WithContributedColumns,
} from "@plugins/network/plugins/live/core";
import type { EntityRef } from "@plugins/infra/plugins/entities/core";
import type { ServedCollection } from "./serve-collection";
import { LiveColumns, type ExposingExtension } from "./serve-columns";
import {
  exposedBinding,
  exposureFolds,
  type ExposureFold,
} from "./exposure-folds";
import {
  bindArm,
  type ArmSpec,
  type DeriveReads,
  type ServedArm,
  type UnionDerived,
} from "./serve-arm";

// `serveUnionCollection` — the server half of a UNION collection
// (`liveCollection(key, { arms })`, P6 of
// research/2026-10-01-global-scoped-change-routing-p5-p8-v2.md, step 12b):
// rows of N kinds, each from its own table, listed in one window. Each arm
// binds the collection's base fields to its own table (by name, through the
// same `j` a `serveCollection` override reads), and its own column set
// (`liveArm`) to its own fields; its rows carry those under
// `$columns[<arm>]`. The compile is query-resource's `compileUnionCollection`;
// what is decided here is the filter language's half:
//
// - **filter targets** — in an arm, a field's target is its read; on another
//   arm's rows it is a typed `NULL`; the discriminator is the arm's kind;
// - **arm pruning** (`armsOf`) — a clause reachable from the root through AND
//   groups only, over an arm CONSTANT (a typed NULL, or the discriminator), is
//   answered once by the op's own `testClause`; a `false` prunes the arm (no
//   SQL, no routes). A negative op or `isEmpty` keeps it (NULL satisfies it);
// - **the decode** — strict, over the static set of the arms' column sets
//   and the exposures they fold.
//
// An arm declared `from` an ENTITY (`liveArm({ from })`, its `reaches`) folds
// that entity's exposed extension fields, as a direct collection `from` it
// does (`./exposure-folds`): each served exposure is LEFT-joined onto the
// arm's base under its slice, its fields bound under their wire names
// (`<slice>.<field>`) and carried on the arm's rows under `$columns[<slice>]`
// — a typed NULL on every other arm's rows, so a filter on one prunes them.
//
// The compile is DEFERRED (`defineDeferredResource`): arms register in the
// register phase (`served.arm(…)` is a `Registration`), so it runs at
// `bindDeferredResources` — before anything serves, and before the change
// feed's ready barrier rebuilds the triggers from the routes.

/** Every relation's refs, as an arm's `j` offers them. */
export type UnionArmRefs = Readonly<
  Record<string, Readonly<Record<string, ColumnRef>>>
>;

/** Every relation's raw columns, as an arm's static `where` reads them. */
export type UnionArmColumns = Readonly<
  Record<string, Readonly<Record<string, PgColumn>>>
>;

/** One field's binding in an arm: a column ref, an expression over refs, or `null` (no such notion). */
export type UnionFieldBinding = ColumnRef | ExprField;

/**
 * One arm, as the union compiles it. Its kind is its column set's arm. Typed
 * loosely here — `served.arm(columns, spec)` (`./serve-arm`) types `j` and
 * each binding's value against the union's row and the arm's fields (T9).
 */
export interface UnionArmBinding {
  /** The arm (`liveArm`) — its `owner.arm` is the arm's kind. */
  columns: LiveColumnsDeclaration;
  /** Its base table (or an entity, read through its table). Never a view. */
  from: RoutedSource;
  /** Its id: the base table's single-column primary key. */
  id: PgColumn;
  joins?: readonly JoinSpec[];
  /**
   * Every base field but the collection's id and discriminator (which the
   * compiler projects) → its binding, or `null` where the arm has no such
   * notion (it reads NULL there).
   */
  base: (j: UnionArmRefs) => Readonly<Record<string, UnionFieldBinding | null>>;
  /** Every field of the arm's column set → its binding. */
  extra: (j: UnionArmRefs) => Readonly<Record<string, UnionFieldBinding>>;
  /** The arm's always-on scope (a namespace, a soft-delete flag). */
  where?: (j: UnionArmColumns) => SQL;
}

/** What `compileUnion` compiles a union from: its arms' bindings (a test hands its own). */
export interface CompileUnionOptions {
  /** The arms — called once, at the deferred bind (after the register phase). */
  arms: () => readonly UnionArmBinding[];
  /**
   * The served exposures (`LiveColumns.Expose`) an entity arm folds — read at
   * the deferred bind by `serveUnionCollection`; a test hands its own.
   */
  exposed?: readonly ExposingExtension[];
  /** Test seam. Defaults to the real per-worktree drizzle `db`. */
  db?: QueryDb;
}

/**
 * What `serveUnionCollection` takes beside the collection: the base fields it
 * DERIVES for every arm (see {@link UnionDerived}) — so no arm supplies one,
 * and no two arms can disagree about it.
 */
export interface ServeUnionOptions<Row, Dv> {
  derive?: Dv & {
    readonly [K in keyof Dv]: K extends keyof Row
      ? UnionDerived<keyof Row & string>
      : never;
  };
}

/**
 * A union collection, served: its resources, and `arm(columns, spec)` — the
 * one way an arm binds its own table into it (typed against the union's base
 * row and the arm's `liveArm`), returning the {@link Registration} its plugin
 * puts in `register: [...]`. The arms are read at the deferred bind, after the
 * register phase: a union never names one, and an arm never edits it.
 */
export interface ServedUnion<
  Row,
  Omitted extends string,
  Reads extends string,
> extends ServedCollection<WithContributedColumns<Row>> {
  arm<
    CRow,
    F,
    S extends string,
    T extends EntityTable,
    // No `joins` → no join relations, not the constraint's open set (whose
    // string index would swallow `base`, so no column could bind).
    const J extends readonly JoinSpec[] = readonly [],
    Pk extends string = never,
  >(
    columns: LiveArmColumnsHandle<WithContributedColumns<Row>, CRow, F, S> & {
      readonly picked?: readonly Pk[];
    },
    spec: ArmSpec<Row, Omitted, Reads, CRow, T, J, Pk>,
  ): ServedArm;
}

function isEntitySource(from: RoutedSource): from is EntitySource {
  return "wireColumns" in from && "table" in from;
}

/**
 * The clauses that hold unconditionally — reachable from the root through AND
 * groups only. Only those may prune an arm: a clause inside an OR is one
 * alternative, and a row failing it can still match.
 */
function conjunctiveClauses(filter: Filter | undefined): FilterClause[] {
  const out: FilterClause[] = [];
  const walk = (f: Filter): void => {
    if ("and" in f) f.and.forEach(walk);
    else if (!("or" in f)) out.push(f);
  };
  if (filter !== undefined) walk(filter);
  return out;
}

/** What one arm is, once bound. */
interface BoundArm {
  kind: string;
  handle: LiveColumnsDeclaration;
  spec: UnionArmSpec;
  /** Filterable name → this arm's target (its read, a typed NULL, or its kind). */
  targets: Record<string, SQL>;
  /** The names this arm reads NULL for as a constant (a pruning answer). */
  constants: ReadonlyMap<string, FilterScalar | null>;
  /** Outer name → the wire codec its value is encoded with. */
  wires: ReadonlyMap<string, WireCodec<unknown, unknown>>;
}

/**
 * Derive a union collection's three server halves. Exported apart from
 * `serveUnionCollection` (which also registers) so a test can compile against
 * its own `db` and runtime. Every binding miss throws here.
 */
export function compileUnion<
  Row,
  F,
  S extends string,
  D extends keyof Row & string,
>(
  collection: LiveArmsCollection<Row, F, S, D>,
  opts: CompileUnionOptions,
): CompiledUnion<
  WithContributedColumns<Row>,
  LiveWindowParams,
  PointParams,
  LiveGroupParams
> {
  const key = collection.key;
  const fail = (message: string): never => {
    throw new Error(`serveUnionCollection("${key}"): ${message}`);
  };
  if (collection.arms === null || collection.arms === undefined) {
    fail("the collection is not declared with `arms`");
  }
  const discriminator: string = collection.arms.discriminator;
  const idField: string = collection.id;
  if (collection.window.queryPk !== idField) {
    fail(
      `the window's key field "${collection.window.queryPk}" is not the id "${idField}".`,
    );
  }
  const baseFields = (collection.rowKeys as readonly string[]).filter(
    (f) => f !== idField && f !== discriminator,
  );
  const rowShape = collection.row.shape as Readonly<Record<string, unknown>>;
  const schemaOf = (
    shape: Readonly<Record<string, unknown>>,
    name: string,
    what: string,
  ): ZodParser<unknown> => {
    const s = shape[name] as Partial<ZodParser<unknown>> | undefined;
    return typeof s?.safeParse === "function"
      ? (s as ZodParser<unknown>)
      : fail(`${what} "${name}" is not a zod schema.`);
  };
  const ownFilterable = collection.filterable as unknown as Filterable;
  for (const name of [...Object.keys(ownFilterable), ...collection.sortable]) {
    if (name === idField) {
      fail(
        `"${name}" is the id — a union row's key is minted by the compiler; filter and sort by its arm's own fields.`,
      );
    }
  }

  const bindings = opts.arms();
  const handles: LiveColumnsDeclaration[] = [];
  /** Wire name → the column set (an arm, or an exposure's slice) and its field. */
  const wireOwner = new Map<string, { set: string; field: string }>();
  for (const b of bindings) {
    const owner = b.columns.owner;
    switch (owner.kind) {
      case "arm":
        if (owner.collection !== key) {
          fail(
            `arm columns "${b.columns.name}" belong to "${owner.collection}".`,
          );
        }
        break;
      case "scoped":
      case "exposed":
        fail(
          `columns "${b.columns.name}" are a ${owner.kind} set — an arm binds its own \`liveArm\`.`,
        );
        break;
      default:
        owner satisfies never;
    }
    if (handles.some((h) => h.name === b.columns.name)) {
      fail(`two arms are of kind "${b.columns.name}" — a kind names one arm.`);
    }
    handles.push(b.columns);
    for (const field of b.columns.fields) {
      wireOwner.set(b.columns.wireName(field), { set: b.columns.name, field });
    }
  }

  // ── The exposures each entity arm folds ───────────────────────────────────
  // One arm per entity: two arms folding one slice would read one wire column,
  // so a filter on "arm A's" exposed field would filter arm B's rows too.
  const reachedBy = new Map<string, string>();
  const armFolds: ExposureFold[][] = bindings.map((b) => {
    const kind = b.columns.name;
    const reaches =
      (b.columns as { readonly reaches?: EntityRef | null }).reaches ?? null;
    if (reaches === null) return [];
    const other = reachedBy.get(reaches.name);
    if (other !== undefined) {
      fail(
        `arms "${other}" and "${kind}" both reach entity "${reaches.name}" — one arm per entity, so an exposed field filters one arm's rows.`,
      );
    }
    reachedBy.set(reaches.name, kind);
    return exposureFolds(
      { base: reaches },
      isEntitySource(b.from) ? b.from.table : (b.from as PgTable),
      b.joins ?? [],
      opts.exposed ?? [],
      // An exposed field is listed beside the arm's own, in its band: its id
      // must not be one of the arm's fields; its slice not a set's name.
      {
        fields: b.columns.fields,
        sets: bindings.map((o) => o.columns.name),
      },
      fail,
    );
  });
  /** Each arm's column sets — its own, then each exposure it folds. */
  const armSets = new Map<string, readonly string[]>();
  bindings.forEach((b, i) => {
    const folds = armFolds[i]!;
    for (const { handle } of folds) {
      if (handles.some((h) => h.name === handle.name)) {
        fail(
          `two column sets are named "${handle.name}" — an exposure's slice names its \`$columns\` slot.`,
        );
      }
      handles.push(handle);
      for (const field of handle.fields) {
        wireOwner.set(handle.wireName(field), { set: handle.name, field });
      }
    }
    armSets.set(b.columns.name, [
      b.columns.name,
      ...folds.map((f) => f.handle.name),
    ]);
  });

  // ── Bind each arm ─────────────────────────────────────────────────────────
  const reads: Map<string, ReadColumn>[] = [];
  const plans: ReturnType<typeof compileJoins>[] = [];
  const armWires: Map<string, WireCodec<unknown, unknown>>[] = [];
  const armWheres: (SQL | undefined)[] = [];
  const armJoins: (readonly JoinSpec[])[] = [];
  for (const [i, b] of bindings.entries()) {
    const kind = b.columns.name;
    const folds = armFolds[i]!;
    if (!KIND_RE.test(kind))
      fail(`arm kind "${kind}" is not a plain identifier.`);
    const label = `serveUnionCollection("${key}") arm "${kind}"`;
    const table: PgTable = isEntitySource(b.from)
      ? b.from.table
      : (b.from as PgTable);
    const sourceColumns: Record<string, PgColumn> = isEntitySource(b.from)
      ? b.from.wireColumns
      : (getTableColumns(table) as Record<string, PgColumn>);
    const joins = [...(b.joins ?? []), ...folds.map((f) => f.join)];
    armJoins.push(joins);
    let renderRef: ((ref: ColumnRef) => ReadColumn) | undefined;
    const refs = joinRefs(sourceColumns, joins, (ref) =>
      (
        renderRef ??
        fail(
          `"${ref.from}"."${ref.col.name}" was rendered before the joins were compiled.`,
        )
      )(ref),
    );
    const plan = compileJoins(
      { table, name: getTableName(table) },
      joins,
      b.id,
      label,
    );
    renderRef = plan.render;
    const read = new Map<string, ReadColumn>();
    const wires = new Map<string, WireCodec<unknown, unknown>>();
    const bind = (name: string, binding: UnionFieldBinding): ReadColumn => {
      if (isExprField(binding)) {
        if (binding.wire !== undefined)
          wires.set(name, binding.wire as WireCodec<unknown, unknown>);
        return plan.renderExpr(binding, { name, baseColumns: sourceColumns });
      }
      if (
        !Object.values(refs[binding.from] ?? {}).some(
          (r) => r.col === binding.col,
        )
      ) {
        fail(
          `arm "${kind}" binds "${name}" to "${binding.from}"."${binding.col.name}", which is not a wire column of that relation.`,
        );
      }
      const codec = columnWireCodec(binding.col);
      if (codec) wires.set(name, codec as WireCodec<unknown, unknown>);
      return plan.render(binding);
    };
    const nullCheck = (
      name: string,
      col: ReadColumn | null,
      schema: ZodParser<unknown>,
    ) => {
      if (
        (col === null || plan.canBeNull(col)) &&
        !schema.safeParse(null).success
      ) {
        fail(
          `arm "${kind}" may read NULL for "${name}" (${col === null ? "it binds none" : "a nullable read"}), but its field is not nullable.`,
        );
      }
    };
    const base = b.base(refs);
    for (const name of Object.keys(base)) {
      if (!baseFields.includes(name)) {
        fail(
          `arm "${kind}" binds "${name}", which is not a base field (the id and the discriminator are the compiler's).`,
        );
      }
    }
    for (const name of baseFields) {
      if (!Object.hasOwn(base, name))
        fail(
          `arm "${kind}" binds no base field "${name}" (bind it, or \`null\` for no such notion).`,
        );
      const binding = base[name]!;
      const col = binding === null ? null : bind(name, binding);
      nullCheck(name, col, schemaOf(rowShape, name, "row field"));
      if (col !== null) read.set(name, col);
    }
    const extra = b.extra(refs);
    const fields = b.columns.fields as readonly string[];
    for (const name of Object.keys(extra)) {
      if (!fields.includes(name))
        fail(
          `arm "${kind}" binds "${name}", which is not a field of its column set.`,
        );
    }
    for (const field of fields) {
      const binding = Object.hasOwn(extra, field)
        ? extra[field]!
        : fail(`arm "${kind}" binds no column of its own field "${field}".`);
      const wire = b.columns.wireName(field);
      const col = bind(wire, binding);
      nullCheck(wire, col, schemaOf(b.columns.rowShape, field, "arm field"));
      read.set(wire, col);
    }
    for (const fold of folds) {
      const { handle, join } = fold;
      for (const field of handle.fields) {
        const wire = handle.wireName(field);
        const col = bind(
          wire,
          exposedBinding(fold, field, refs[join.alias], fail),
        );
        nullCheck(wire, col, schemaOf(handle.rowShape, field, "exposed field"));
        read.set(wire, col);
      }
    }
    reads.push(read);
    plans.push(plan);
    armWires.push(wires);
    armWheres.push(b.where?.(plan.columns()));
  }

  // ── The outer columns, typed by their first read ─────────────────────────
  const outerNames = [
    ...baseFields,
    ...handles.flatMap((h) => h.fields.map((f) => h.wireName(f))),
  ];
  const columns: UnionColumn[] = outerNames.map((name) => {
    const i = reads.findIndex((r) => r.has(name));
    // A base field no arm reads is NULL everywhere: any type unions with it.
    return {
      name,
      sqlType: i === -1 ? "text" : plans[i]!.sqlTypeOf(reads[i]!.get(name)!),
    };
  });
  const typeOf = new Map(columns.map((c) => [c.name, c.sqlType] as const));

  // ── Filter language ───────────────────────────────────────────────────────
  const filterDecl: Filterable = {
    ...ownFilterable,
    ...Object.assign({}, ...handles.map((h) => h.wireFilterable)),
  };
  for (const name of Object.keys(filterDecl)) {
    if (name !== discriminator && !typeOf.has(name))
      fail(`"${name}" is not a field of the row schema.`);
  }
  const sortable = [
    ...collection.sortable,
    ...handles.flatMap((h) => h.wireSortable),
  ];
  for (const name of sortable) {
    if (name !== discriminator && !typeOf.has(name))
      fail(`"${name}" is not a field of the row schema.`);
  }
  const arms: BoundArm[] = bindings.map((b, i) => {
    const kind = b.columns.name;
    const targets: Record<string, SQL> = {};
    const constants = new Map<string, FilterScalar | null>();
    for (const name of Object.keys(filterDecl)) {
      if (name === discriminator) {
        targets[name] = sql.raw(`'${kind}'::text`);
        constants.set(name, kind);
        continue;
      }
      const col = reads[i]!.get(name);
      if (col === undefined) {
        targets[name] = sql.raw(`NULL::${typeOf.get(name)!}`);
        constants.set(name, null);
      } else {
        targets[name] = sql`${col}`;
      }
    }
    return {
      kind,
      handle: b.columns,
      targets,
      constants,
      wires: armWires[i]!,
      spec: {
        kind,
        from: b.from,
        id: b.id,
        ...(armJoins[i]!.length > 0 ? { joins: armJoins[i]! } : {}),
        reads: Object.fromEntries(reads[i]!),
        ...(armWheres[i] ? { where: armWheres[i] } : {}),
        whereReads: Object.keys(filterDecl)
          .map((name) => reads[i]!.get(name))
          .filter((c): c is ReadColumn => c !== undefined),
      },
    };
  });
  const armByKind = new Map(arms.map((a) => [a.kind, a] as const));
  const prune = (filter: Filter | undefined): ReadonlySet<string> => {
    const clauses = conjunctiveClauses(filter);
    return new Set(
      arms
        .filter(
          (arm) =>
            !clauses.some(
              (c) =>
                arm.constants.has(c.column) &&
                !testClause(arm.constants.get(c.column), c, filterDecl),
            ),
        )
        .map((arm) => arm.kind),
    );
  };
  const whereIn = (filter: Filter | undefined, kind: string): SQL | undefined =>
    filterSql(filter, armByKind.get(kind)!.targets, filterDecl);

  const codec = collection.window.window;
  const decoded = new WeakMap<
    LiveWindowParams,
    ReturnType<typeof codec.decode>
  >();
  const decode = (params: LiveWindowParams) => {
    let d = decoded.get(params);
    if (d === undefined) {
      d = codec.decode(params, handles);
      decoded.set(params, d);
    }
    return d;
  };
  const groupCodec = collection.groups.groups;
  /** A grouped column's field schema: a base field's, or its column set's. */
  const groupSchema = (name: string): ZodParser<unknown> => {
    const owner = wireOwner.get(name);
    if (owner === undefined) return schemaOf(rowShape, name, "row field");
    const handle = handles.find((h) => h.name === owner.set)!;
    return schemaOf(handle.rowShape, owner.field, "column-set field");
  };

  // ── Rows on the wire ──────────────────────────────────────────────────────
  const encodeRow = (row: Record<string, unknown>): Record<string, unknown> => {
    const out = { ...row };
    const kind = out[discriminator] as string;
    const arm = armByKind.get(kind) ?? fail(`a row of no arm (${kind}).`);
    for (const [name, wire] of arm.wires) {
      const v = out[name];
      if (v !== null && v !== undefined) out[name] = wire.encode(v);
    }
    const cols: Record<string, Record<string, unknown>> = {};
    for (const set of armSets.get(kind)!) cols[set] = {};
    for (const [wire, { set, field }] of wireOwner) {
      const slice = cols[set];
      if (slice !== undefined) slice[field] = out[wire];
      delete out[wire];
    }
    out[LIVE_COLUMNS_KEY] = cols;
    return out;
  };
  const readField = (row: Record<string, unknown>, name: string): unknown => {
    const owner = wireOwner.get(name);
    if (owner === undefined) return row[name];
    const cols = row[LIVE_COLUMNS_KEY] as Record<
      string,
      Record<string, unknown>
    >;
    return cols[owner.set]?.[owner.field] ?? null;
  };

  const compiled = compileUnionCollection<
    WithContributedColumns<Row>,
    LiveWindowParams,
    PointParams,
    LiveGroupParams
  >({
    key,
    keyField: idField,
    discriminator,
    columns,
    arms: arms.map((a) => a.spec),
    sortable,
    window: {
      armsOf: (params) => prune(decode(params).where),
      whereOf: (params, kind) => whereIn(decode(params).where, kind),
      orderOf: (params) =>
        decode(params).orderBy.map(([name, dir]) => ({ name, dir })),
      limitOf: (params) => decode(params).limit,
      cutsOf: (params) => {
        const { after, until } = decode(params);
        return {
          ...(after !== undefined ? { after } : {}),
          ...(until !== undefined ? { until } : {}),
        };
      },
      familyOf: codec.familyOf,
      validateParams: (params) => {
        codec.decode(params as LiveWindowParams, handles);
      },
    },
    rowKey: { keyField: LIVE_ROW_KEY, maxKeyBytes: LIVE_ROW_KEY_MAX_BYTES },
    point: { idsOf: (params) => collection.rows.point.decode(params) },
    groups: {
      query: (params) => {
        const q = groupCodec.decode(params, handles);
        const schema = groupSchema(q.groupBy);
        return {
          groupBy: q.groupBy,
          arms: prune(q.where),
          whereOf: (kind) => whereIn(q.where, kind),
          limit: q.limit,
          check: (value) => {
            if (!schema.safeParse(value).success) {
              fail(
                `group value ${JSON.stringify(value)} of "${q.groupBy}" does not parse as the row schema's field.`,
              );
            }
          },
        };
      },
    },
    readField,
    encodeRow,
    ...(opts.db ? { db: opts.db } : {}),
  });
  // The params gate: the descriptor's own decode knows no column set, and
  // would refuse a grouping by an arm's or an exposure's field (as the
  // window's `validateParams` above).
  return {
    ...compiled,
    groups: {
      ...compiled.groups,
      validateParams: (params) => {
        groupCodec.decode(params as LiveGroupParams, handles);
      },
    },
  };
}

/**
 * Serve a UNION collection — a Meta-DataView's rows: every arm bound through
 * the returned `arm(columns, spec)`, read once at the deferred bind (after
 * the register phase, where the arms' registrations run). `derive` names the
 * base fields the union computes for every arm itself (a run's duration, from
 * its start and finish). Returns the three resources, their keys, their
 * `Resource.Declare` contributions and `arm`:
 *
 * ```ts
 * export const runsServed = serveUnionCollection(runs, {
 *   derive: { duration: { reads: ["startedAt", "finishedAt"], bind: (r) => durationOf(r) } },
 * });
 * // contributions: [...runsServed.declare]
 * // an arm's server: export const buildRunServed = runsServed.arm(buildRunArm, { from, id, base, extra });
 * //                  register: [buildRunServed]
 * ```
 */
export function serveUnionCollection<
  Row,
  F,
  S extends string,
  D extends keyof Row & string,
  I extends keyof Row & string,
  const Dv extends object = Record<never, never>,
>(
  collection: LiveArmsCollection<Row, F, S, D> & { id: I },
  opts: ServeUnionOptions<Row, Dv> = {},
): ServedUnion<Row, I | D | (keyof Dv & string), DeriveReads<Dv>> {
  const arms = new Map<string, ServedArm>();
  const derive = (opts.derive ?? {}) as Readonly<
    Record<string, UnionDerived<string> | undefined>
  >;
  const register = (arm: ServedArm): void => {
    if (arms.has(arm.kind)) {
      throw new Error(
        `serveUnionCollection("${collection.key}"): two arms are of kind "${arm.kind}" — a kind names one arm.`,
      );
    }
    arms.set(arm.kind, arm);
  };
  let compiled:
    | CompiledUnion<
        WithContributedColumns<Row>,
        LiveWindowParams,
        PointParams,
        LiveGroupParams
      >
    | undefined;
  const once = () =>
    (compiled ??= compileUnion(collection, {
      arms: () => [...arms.values()].map((a) => a.binding),
      exposed: LiveColumns.Expose.getContributions(),
    }));
  const window = defineDeferredResource(collection.window, () => once().window);
  const rows = defineDeferredResource(collection.rows, () => once().rows);
  // A group's value is checked against the row schema in the loader
  // (`check`), so the wire row is the collection's `LiveGroup`.
  const groups = defineDeferredResource(
    collection.groups,
    () =>
      once().groups as unknown as CompiledGroups<
        LiveGroup<FilterScalar>,
        LiveGroupParams
      >,
  );
  return {
    window,
    rows,
    groups,
    // A union has no total (`count` is refused beside `arms`).
    count: null,
    keys: [window.key, rows.key, groups.key],
    declare: [
      ResourceContribution.Declare(window),
      ResourceContribution.Declare(rows),
      ResourceContribution.Declare(groups),
    ],
    arm: (columns, spec) =>
      bindArm(
        collection.key,
        columns as unknown as Parameters<typeof bindArm>[1],
        spec as unknown as Parameters<typeof bindArm>[2],
        derive,
        register,
      ),
  };
}
