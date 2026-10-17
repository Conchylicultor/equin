import type { SQL } from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
import type { Registration } from "@plugins/framework/plugins/server-core/core";
import type {
  ColumnRef,
  ExprField,
  JoinColumns,
  JoinRefs,
  JoinSpec,
  TypedColumnRef,
} from "@plugins/infra/plugins/query-resource/core";
import type {
  LIVE_COLUMNS_KEY,
  LiveArmColumnsHandle,
} from "@plugins/network/plugins/live/core";
import type {
  UnionArmBinding,
  UnionArmColumns,
  UnionFieldBinding,
} from "./serve-union";

// An ARM of a union collection (a Meta-DataView's source), bound to its own
// table — typed against the union's base row and the arm's own fields, so a
// field with no binding, a binding with no field, or a column of the wrong
// type is a tsc error (and `compileUnion` re-checks every key set at bind).
// `served.arm(columns, spec)` (see `serveUnionCollection`) is the one way an
// arm binds; the union never names one.

/** `j` of an arm over table `T` and joins `J`: each relation's wire columns, as refs. */
export type ArmRefs<
  T extends PgTable,
  J extends readonly JoinSpec[],
> = JoinRefs<T["_"]["columns"], J>;

/** The value a column reads as: its data type, `| null` unless it is NOT NULL. */
type ColumnValue<C extends PgColumn> = C["_"]["notNull"] extends true
  ? C["_"]["data"]
  : C["_"]["data"] | null;

/**
 * The refs `j` offers whose column reads as a `V` — narrowed by the column's
 * own type, so binding an integer column to a text field (or a nullable one to
 * a NOT NULL field) is a tsc error rather than a row the browser's parse
 * refuses. (A non-required join's column is NULL on a miss whatever its type
 * says; the compile checks that nullability at bind.)
 */
export type TypedArmRef<Refs, V> = {
  [R in keyof Refs]: {
    [K in keyof Refs[R]]: Refs[R][K] extends TypedColumnRef<string, infer C>
      ? [ColumnValue<C>] extends [V]
        ? Refs[R][K]
        : never
      : never;
  }[keyof Refs[R]];
}[keyof Refs];

/**
 * One field's binding: a column ref `j` offers whose column reads as the
 * field's type, or an expression over them whose VALUE type is the field's.
 */
export type ArmFieldBinding<
  T extends PgTable,
  J extends readonly JoinSpec[],
  V,
> = TypedArmRef<ArmRefs<T, J>, V> | ExprField<V>;

/**
 * A base field the union DERIVES for every arm (`serveUnionCollection(c, {
 * derive })`), so no arm supplies it and no two arms can disagree about it:
 * `reads` names the base fields it is computed from — each of which every arm
 * then binds to a COLUMN (it is interpolated into `bind`'s SQL) — and `bind`
 * builds it from those columns and the arm's own id.
 */
export interface UnionDerived<R extends string> {
  readonly reads: readonly R[];
  bind(
    reads: { readonly [K in R]: ColumnRef },
    ctx: { id: ColumnRef },
  ): UnionFieldBinding;
}

/** The base fields a union's `derive` reads, over all its derived fields. */
export type DeriveReads<Dv> = {
  [K in keyof Dv]: Dv[K] extends { readonly reads: readonly (infer X)[] }
    ? X
    : never;
}[keyof Dv] &
  string;

/**
 * Where an arm's base fields come from — one key per base field but the id,
 * the discriminator (the compiler's) and the derived ones (`Omitted`). A field
 * a derived one reads (`Reads`) is a column; a nullable field may be `null`
 * ("this arm has no such notion"), a non-nullable one may not.
 */
export type ArmBase<
  Row,
  Omitted extends string,
  Reads extends string,
  T extends PgTable,
  J extends readonly JoinSpec[],
> = {
  [
    K in Exclude<keyof Row & string, Omitted | typeof LIVE_COLUMNS_KEY>
  ]: K extends Reads
    ? TypedArmRef<ArmRefs<T, J>, Row[K]>
    : null extends Row[K]
      ? ArmFieldBinding<T, J, Row[K]> | null
      : ArmFieldBinding<T, J, Row[K]>;
} & {
  // The id, the discriminator and the derived fields are the union's: an arm
  // binding one is a tsc error (a callback's return gets no excess-key check).
  readonly [K in Omitted & keyof Row]?: never;
};

/** What an arm hands `served.arm(columns, spec)`. */
export interface ArmSpec<
  Row,
  Omitted extends string,
  Reads extends string,
  CRow,
  T extends PgTable,
  J extends readonly JoinSpec[],
  Pk extends string = never,
> {
  /** The arm's own table (plugin-private; only bound here). Never a view. */
  from: T;
  /** Its single-column primary key — the row key encodes it. */
  id: PgColumn;
  joins?: J;
  base: (j: ArmRefs<T, J>) => ArmBase<Row, Omitted, Reads, T, J>;
  /**
   * Every field of the arm's column set (`liveArm`) → its binding. A field
   * the arm picks from its entity (`liveArm({ from, pick })`) binds by name —
   * to the `from` column of the same name — unless bound here.
   */
  extra: (j: ArmRefs<T, J>) => {
    [K in Exclude<keyof CRow & string, Pk>]-?: ArmFieldBinding<T, J, CRow[K]>;
  } & {
    [K in Pk & keyof CRow & string]?: ArmFieldBinding<T, J, CRow[K]>;
  };
  /** Always-on scope for this arm — a namespace, a soft-delete flag. */
  where?: (j: JoinColumns<T, J>) => SQL;
}

/** A bound arm: its kind, its binding into the union, and the registration that adds it. */
export interface ServedArm extends Registration {
  readonly kind: string;
  readonly binding: UnionArmBinding;
}

/**
 * Bind one arm: erase the typed spec to the union's loose binding, folding in
 * the union's derived base fields. Every binding was type-checked against the
 * row and the arm's column set; `compileUnion` re-checks the key sets.
 */
export function bindArm(
  unionKey: string,
  columns: LiveArmColumnsHandle<never, unknown, unknown, string> & {
    readonly picked?: readonly string[];
  },
  spec: ArmSpec<unknown, string, string, unknown, PgTable, readonly JoinSpec[]>,
  derive: Readonly<Record<string, UnionDerived<string> | undefined>>,
  register: (arm: ServedArm) => void,
): ServedArm {
  const kind = columns.owner.arm;
  const fail = (message: string): never => {
    throw new Error(
      `serveUnionCollection("${unionKey}") arm "${kind}": ${message}`,
    );
  };
  if (columns.owner.collection !== unionKey) {
    fail(`its columns belong to "${columns.owner.collection}".`);
  }
  const binding: UnionArmBinding = {
    columns,
    from: spec.from,
    id: spec.id,
    ...(spec.joins ? { joins: spec.joins } : {}),
    base: (j) => {
      const own = spec.base(j as never) as Readonly<
        Record<string, UnionFieldBinding | null>
      >;
      const out: Record<string, UnionFieldBinding | null> = { ...own };
      for (const [name, derived] of Object.entries(derive)) {
        if (derived === undefined) continue;
        if (Object.hasOwn(own, name)) {
          fail(`binds "${name}", which the union derives.`);
        }
        const reads: Record<string, ColumnRef> = {};
        for (const r of derived.reads) {
          const b = own[r];
          if (b === undefined || b === null || !("col" in b)) {
            fail(
              `binds "${r}" to ${b === null ? "null" : "no column"}, but the union derives "${name}" from it — bind it to a column.`,
            );
          }
          reads[r] = b as ColumnRef;
        }
        out[name] = derived.bind(reads, { id: { from: "base", col: spec.id } });
      }
      return out;
    },
    extra: (j) => {
      const own = spec.extra(j as never) as Readonly<
        Record<string, UnionFieldBinding>
      >;
      const out: Record<string, UnionFieldBinding> = { ...own };
      for (const name of columns.picked ?? []) {
        if (Object.hasOwn(own, name)) continue;
        const ref = j.base?.[name];
        if (ref === undefined) {
          fail(
            `picks "${name}" from its entity, but its table has no wire column of that name — bind it in \`extra\`.`,
          );
        }
        out[name] = ref!;
      }
      return out;
    },
    ...(spec.where
      ? {
          where: (j: UnionArmColumns) =>
            spec.where!(j as unknown as JoinColumns<PgTable, readonly []>),
        }
      : {}),
  };
  const arm: ServedArm = {
    kind,
    binding,
    _kind: "union-arm",
    _factory: "serveArm",
    _doc: { label: `${unionKey}:${kind}` },
    register() {
      register(arm);
    },
  };
  return arm;
}
