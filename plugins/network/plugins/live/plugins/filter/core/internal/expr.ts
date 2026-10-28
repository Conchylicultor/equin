import type { z } from "zod";
import type { FilterDomainId } from "./domains";
import type { FilterOpId, OperandKindOf, OpsFor } from "./ops";

// The expression language's types, the declaration constructors and the tree
// helpers. A `Filter` is a clause or an AND / OR group, nested at most
// `FILTER_MAX_DEPTH` levels. There is no `not` node: every negation is an op
// (`ne`, `notIn`, `hasNone` …), so a negation never has to be pushed through a
// tree. The absent filter (match everything) is `undefined`; `{ or: [] }`
// matches nothing.

declare const operandType: unique symbol;

/**
 * A filterable column's declaration: its domain, plus — at tsc level only —
 * the type a `value` / `list` operand must have (an enum column's options).
 * At runtime an operand is only ever checked against the DOMAIN.
 */
export interface FilterColumn<
  D extends FilterDomainId = FilterDomainId,
  V = unknown,
> {
  readonly domain: D;
  readonly [operandType]?: V;
}

/** The declared filterable columns: column → its domain. A security whitelist — anything else is refused. */
export type Filterable = { readonly [column: string]: FilterColumn };

/** A text column (enum, uuid, …). The optional schema narrows its `value` / `list` operands in tsc only. */
export function liveText<S extends string = string>(
  _narrow?: z.ZodType<S>,
): FilterColumn<"text", S> {
  return { domain: "text" };
}

/** A finite-number column (`int`, `float`, …). */
export function liveNumber(): FilterColumn<"number", number> {
  return { domain: "number" };
}

export function liveBoolean(): FilterColumn<"boolean", boolean> {
  return { domain: "boolean" };
}

/** A point in time: rows hold a `Date` or an ISO-Z string; operands are ISO-Z strings (ms precision). */
export function liveInstant(): FilterColumn<"instant", string> {
  return { domain: "instant" };
}

/** A jsonb string array (tags, label ids). The optional schema narrows its elements in tsc only. */
export function liveStringArray<S extends string = string>(
  _narrow?: z.ZodType<S>,
): FilterColumn<"stringArray", S> {
  return { domain: "stringArray" };
}

type OperandTypeOf<Col> =
  Col extends FilterColumn<FilterDomainId, infer V> ? V : never;

type DomainOf<Col> = Col extends FilterColumn<infer D> ? D : never;

/** The operand op `K` takes over a column whose operands are `V`. */
export type FilterOperand<K extends FilterOpId, V> =
  OperandKindOf<K> extends "value"
    ? V
    : OperandKindOf<K> extends "pattern"
      ? string
      : OperandKindOf<K> extends "list"
        ? readonly V[]
        : never;

type ClauseOf<C extends string, K extends FilterOpId, V> =
  OperandKindOf<K> extends "none"
    ? { readonly column: C; readonly op: K; readonly operand?: undefined }
    : {
        readonly column: C;
        readonly op: K;
        readonly operand: FilterOperand<K, V>;
      };

type ColumnClause<C extends string, Col> = {
  [K in OpsFor<DomainOf<Col>>]: ClauseOf<C, K, OperandTypeOf<Col>>;
}[OpsFor<DomainOf<Col>>];

/**
 * One clause over a declared column, correlated per op: the op must take the
 * column's domain, and the operand must be the op's kind over the column's
 * operand type.
 */
export type FilterClause<F extends Filterable = Filterable> = {
  [C in keyof F & string]: ColumnClause<C, F[C]>;
}[keyof F & string];

export type FilterGroup<F extends Filterable = Filterable> =
  | { readonly and: readonly Filter<F>[] }
  | { readonly or: readonly Filter<F>[] };

export type Filter<F extends Filterable = Filterable> =
  FilterClause<F> | FilterGroup<F>;

/** At most this many group levels (a lone clause is depth 0). */
export const FILTER_MAX_DEPTH = 4;
/** At most this many clauses in a canonical filter. */
export const FILTER_MAX_CLAUSES = 50;

export function and<F extends Filterable = Filterable>(
  ...children: readonly Filter<F>[]
): Filter<F> {
  return { and: children };
}

export function or<F extends Filterable = Filterable>(
  ...children: readonly Filter<F>[]
): Filter<F> {
  return { or: children };
}

type NoOperandOp = {
  [K in FilterOpId]: OperandKindOf<K> extends "none" ? K : never;
}[FilterOpId];

/**
 * A clause literal — `clause("status", "in", ["done"])`, `clause("title",
 * "isEmpty")`. Checked against a declaration where it lands (an `and(...)` /
 * `or(...)` / a typed `where`), so its literals are kept narrow.
 */
export function clause<const C extends string, const K extends NoOperandOp>(
  column: C,
  op: K,
): { readonly column: C; readonly op: K };
export function clause<
  const C extends string,
  const K extends Exclude<FilterOpId, NoOperandOp>,
  const O,
>(
  column: C,
  op: K,
  operand: O,
): { readonly column: C; readonly op: K; readonly operand: O };
export function clause(
  column: string,
  op: FilterOpId,
  ...operand: [] | [unknown]
): {
  readonly column: string;
  readonly op: FilterOpId;
  readonly operand?: unknown;
} {
  return operand.length === 0
    ? { column, op }
    : { column, op, operand: operand[0] };
}

export function isFilterGroup(
  f: Filter,
): f is
  { readonly and: readonly Filter[] } | { readonly or: readonly Filter[] } {
  return "and" in f || "or" in f;
}

/** Every column a filter reads. */
export function filterColumns(filter: Filter | undefined): Set<string> {
  const out = new Set<string>();
  const walk = (f: Filter): void => {
    if ("and" in f) f.and.forEach(walk);
    else if ("or" in f) f.or.forEach(walk);
    else out.add(f.column);
  };
  if (filter !== undefined) walk(filter);
  return out;
}
