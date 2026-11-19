import {
  filterDomains,
  type FilterDomainId,
  type FilterValue,
} from "./domains";
import {
  asciiLower,
  compareScalars,
  containsPattern,
  type FilterScalar,
} from "./scalars";
import { complementTpl, L, orEach, P, T, tpl, X, type Tpl } from "./tpl";

// The ONE op table: every op carries its in-memory `test` and its SQL side by
// side, so the two are written, reviewed and changed together — and the
// Postgres parity suite (`server/internal/parity.test.ts`) pins them against
// each other for every op × domain.
//
// Logic is two-valued. NULL (and an empty/non-array set) matches no positive
// op except `isEmpty`, and every negative op is the exact COMPLEMENT of its
// positive, built only by `complementOf`: its test is `!pos.test` and its SQL
// `(<pos>) IS NOT TRUE` — so "a negative keeps NULL" holds by construction,
// never restated per op. Range ops (`lt` …) are positive and fail on NULL.

/**
 * What an op takes:
 * - `value` — one operand of the column's type (narrowed at tsc level);
 * - `pattern` — one free string (case-insensitive ops: not a stored value, so
 *   never narrowed to an enum's options);
 * - `list` — a list of the column's type (or of a string set's elements);
 * - `none` — no operand.
 */
export type OperandKind = "value" | "pattern" | "list" | "none";

/** The operand an op's `test` receives, after domain normalization (instants as epoch ms). */
export type NormalizedOperand<K extends OperandKind> = K extends "value"
  ? FilterScalar
  : K extends "pattern"
    ? string
    : K extends "list"
      ? readonly FilterScalar[]
      : undefined;

/** One template for every domain, or one per domain where the SQL differs. */
export type OpSql<D extends FilterDomainId> = Tpl | { readonly [X in D]: Tpl };

interface OpDef<K extends OperandKind, D extends FilterDomainId> {
  readonly domains: readonly D[];
  readonly operand: K;
  /** The in-memory answer. `value` is already normalized by the column's domain. */
  readonly test: (
    value: FilterValue | null,
    operand: NormalizedOperand<K>,
    domain: D,
  ) => boolean;
  readonly sql: OpSql<D>;
  /** The param `P` binds, from the canonical operand — defaults to the operand itself. */
  readonly bind?: (operand: string) => string;
}

interface PositiveOpDef<
  K extends OperandKind,
  D extends FilterDomainId,
> extends OpDef<K, D> {
  readonly complementOf?: never;
}

function op<K extends OperandKind, const D extends FilterDomainId>(
  def: PositiveOpDef<K, D>,
): PositiveOpDef<K, D> {
  return def;
}

function scalar(value: FilterValue | null): FilterScalar | null {
  return value as FilterScalar | null;
}

function set(value: FilterValue | null): readonly string[] | null {
  return value as readonly string[] | null;
}

function cmp(pass: (c: number) => boolean) {
  return (value: FilterValue | null, operand: FilterScalar): boolean => {
    const v = scalar(value);
    return v !== null && pass(compareScalars(v, operand));
  };
}

// An instant compares floor_ms(value) with a ms-aligned operand (see
// domains.ts). `floor(t) <= p` ⇔ `t < p + 1ms` and `floor(t) > p` ⇔
// `t >= p + 1ms` — the sargable spelling of the same comparison, so a µs
// `timestamptz` answers exactly as its truncated in-memory `Date` does.

const positiveOps = {
  eq: op({
    domains: ["text", "number", "boolean"],
    operand: "value",
    test: cmp((c) => c === 0),
    sql: tpl`${T} = ${P}`,
  }),
  in: op({
    domains: ["text", "number"],
    operand: "list",
    test: (value, list) => {
      const v = scalar(value);
      return v !== null && list.some((x) => compareScalars(v, x) === 0);
    },
    sql: tpl`${T} = ANY(${L})`,
  }),
  lt: op({
    domains: ["text", "number", "instant"],
    operand: "value",
    test: cmp((c) => c < 0),
    sql: tpl`${T} < ${P}`,
  }),
  lte: op({
    domains: ["text", "number", "instant"],
    operand: "value",
    test: cmp((c) => c <= 0),
    sql: {
      text: tpl`${T} <= ${P}`,
      number: tpl`${T} <= ${P}`,
      instant: tpl`${T} < ${P} + interval '1 millisecond'`,
    },
  }),
  gt: op({
    domains: ["text", "number", "instant"],
    operand: "value",
    test: cmp((c) => c > 0),
    sql: {
      text: tpl`${T} > ${P}`,
      number: tpl`${T} > ${P}`,
      instant: tpl`${T} >= ${P} + interval '1 millisecond'`,
    },
  }),
  gte: op({
    domains: ["text", "number", "instant"],
    operand: "value",
    test: cmp((c) => c >= 0),
    sql: tpl`${T} >= ${P}`,
  }),
  eqCi: op({
    domains: ["text"],
    operand: "pattern",
    test: (value, operand) => {
      const v = scalar(value);
      return v !== null && asciiLower(v as string) === asciiLower(operand);
    },
    sql: tpl`lower(${T}) = lower(${P})`,
  }),
  contains: op({
    domains: ["text"],
    operand: "pattern",
    test: (value, operand) => {
      const v = scalar(value);
      return (
        v !== null && asciiLower(v as string).includes(asciiLower(operand))
      );
    },
    sql: tpl`${T} ILIKE ${P}`,
    bind: containsPattern,
  }),
  hasAll: op({
    domains: ["stringArray"],
    operand: "list",
    test: (value, list) => {
      const v = set(value);
      return v !== null && list.every((x) => v.includes(x as string));
    },
    sql: tpl`(jsonb_typeof(${T}) = 'array' AND ${T} @> to_jsonb(${L}))`,
  }),
  // One `@>` per element rather than `?|`: a `jsonb_path_ops` GIN index
  // (mail's label ids) serves `@>` only.
  hasAny: op({
    domains: ["stringArray"],
    operand: "list",
    test: (value, list) => {
      const v = set(value);
      return v !== null && list.some((x) => v.includes(x as string));
    },
    sql: tpl`(jsonb_typeof(${T}) = 'array' AND ${orEach(tpl`${T} @> jsonb_build_array(${X})`)})`,
  }),
  isEmpty: op({
    domains: ["text", "number", "boolean", "instant", "stringArray"],
    operand: "none",
    test: (value, _operand, domain) => filterDomains[domain].isEmpty(value),
    sql: {
      // The class spelled out (not [[:space:]]) so it cannot follow a ctype
      // change away from `isAsciiBlank`.
      text: tpl`(${T} IS NULL OR ${T} ~ '^[ \t\n\v\f\r]*$')`,
      number: tpl`${T} IS NULL`,
      boolean: tpl`${T} IS NULL`,
      instant: tpl`${T} IS NULL`,
      stringArray: tpl`(${T} IS NULL OR jsonb_typeof(${T}) <> 'array' OR ${T} = '[]'::jsonb)`,
    },
  }),
} as const;

type PositiveOps = typeof positiveOps;
type PositiveOpId = keyof PositiveOps;

type ComplementOp<Id extends PositiveOpId> = Omit<
  PositiveOps[Id],
  "complementOf"
> & { readonly complementOf: Id };

/** The ONLY way to spell a negative op: exactly the rows `id` does not match, NULL included. */
function complementOf<const Id extends PositiveOpId>(id: Id): ComplementOp<Id> {
  const pos = positiveOps[id] as unknown as OpDef<OperandKind, FilterDomainId>;
  const sql: OpSql<FilterDomainId> =
    "strings" in pos.sql
      ? complementTpl(pos.sql)
      : (Object.fromEntries(
          Object.entries(pos.sql).map(([d, t]) => [d, complementTpl(t)]),
        ) as Record<FilterDomainId, Tpl>);
  const neg: OpDef<OperandKind, FilterDomainId> & { complementOf: Id } = {
    ...pos,
    test: (value, operand, domain) => !pos.test(value, operand, domain),
    sql,
    complementOf: id,
  };
  return neg as unknown as ComplementOp<Id>;
}

export const filterOps = {
  ...positiveOps,
  ne: complementOf("eq"),
  notIn: complementOf("in"),
  neCi: complementOf("eqCi"),
  notContains: complementOf("contains"),
  hasNone: complementOf("hasAny"),
  isNotEmpty: complementOf("isEmpty"),
};

type FilterOps = typeof filterOps;
export type FilterOpId = keyof FilterOps;

/** Each domain's ops, computed once over the concrete domains. */
type OpsByDomain = {
  [D in FilterDomainId]: {
    [K in FilterOpId]: D extends FilterOps[K]["domains"][number] ? K : never;
  }[FilterOpId];
};

/**
 * The ops a domain takes — derived from the table's `domains`, so it cannot
 * drift. A lookup in {@link OpsByDomain}, not the conditional per op written
 * inline: over a generic domain (a column type a call's contextual type
 * reaches before its type arguments are fixed) that conditional is a union of
 * one deferred conditional per op, which every mapped type over the ops
 * (`ExactlyOne`'s `Exclude` per op) squares; the lookup stays one deferred
 * indexed access (research/2026-11-19-global-use-live-checker-types.md).
 */
export type OpsFor<D extends FilterDomainId> = OpsByDomain[D];

/** An op's operand kind. */
export type OperandKindOf<K extends FilterOpId> = FilterOps[K]["operand"];

/** The type-erased view of one op — what the evaluator, codec and renderer walk. */
export type AnyFilterOp = OpDef<OperandKind, FilterDomainId> & {
  readonly complementOf?: PositiveOpId;
};

export function isFilterOpId(s: string): s is FilterOpId {
  return Object.hasOwn(filterOps, s);
}

export function getFilterOp(id: FilterOpId): AnyFilterOp {
  return filterOps[id] as unknown as AnyFilterOp;
}

export function opAllowsDomain(
  id: FilterOpId,
  domain: FilterDomainId,
): boolean {
  return (getFilterOp(id).domains as readonly FilterDomainId[]).includes(
    domain,
  );
}

/** The op's SQL template over `domain` (the op must take the domain). */
export function opTemplate(id: FilterOpId, domain: FilterDomainId): Tpl {
  const { sql } = getFilterOp(id);
  if ("strings" in sql) return sql;
  const t = (sql as Partial<Record<FilterDomainId, Tpl>>)[domain];
  if (t === undefined) {
    throw new Error(`filter: op "${id}" has no SQL for domain ${domain}`);
  }
  return t;
}

/** `in` / `notIn` / `hasAll` … list cap — keeps a params key and the SQL bounded. */
export const LIST_MAX = 100;
