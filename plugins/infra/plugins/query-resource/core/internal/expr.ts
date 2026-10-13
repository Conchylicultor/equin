// `ExprField` — a row field computed by a SQL EXPRESSION over the relations a
// routed compile reads (research/2026-10-01-global-scoped-change-routing-p5-p8-v2.md,
// step 10): one primitive for every compiler (a collection's field, a union
// arm's computed label or outcome, a persisted alias's nested object), so none
// of them hand-rolls a raw `sql` projection whose provenance, nullability and
// value type nothing checks. It binds where a column override does, over the
// same `j`:
//
//   columns: {
//     label: (j) => expr(sql`${j.base.compositionId} || ' on ' || coalesce(${j.server.name}, ${j.base.serverId})`,
//                        { decoder: String, sqlType: "text", notNull: true }),
//   }
//
// - `j.<relation>.<column>` is a `TypedColumnRef` that also renders as SQL: the
//   relation's DEFAULTED WIRE column (an extension column with a literal
//   default reads its COALESCE, so the expression sees what the field would).
//   A server-only column is not offered; a base one is read by naming the
//   table's column and declaring it in `serverOnly` — the compile throws on
//   any other.
// - The compile reads the expression's provenance off its SQL (`columnsIn`):
//   every column it reads routes like a projected one, and a relation that is
//   neither the base nor a declared join throws (a correlated subquery over an
//   undeclared table cannot be written).
// - Its VALUE type is the decoder's (`GetDecoderResult`), `| null` unless
//   `notNull: true`, or the `wire` codec's output when the stored value cannot
//   cross the JSON wire as is. A binding site requires it to be the row field's
//   type (tsc), and the compile backstops the nullability at runtime.
//
// (`j` is the binding's parameter, not the expression's: TypeScript cannot
// infer a nested generic call's parameter from a contextual type that is still
// being inferred, so `expr((j) => …)` inside `columns` would type `j` as
// nothing. The binding's own arrow is typed like any column override.)
//
// Browser-safe: type-only drizzle imports.

import type { DriverValueDecoder, GetDecoderResult, SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import type { ZodParser } from "@plugins/packages/plugins/zod-parser/core";

/**
 * A Postgres type name, optionally an array of one (`text`, `double
 * precision`, `text[]`) — interpolated raw into casts (a page cut's
 * operand), so it is checked at declaration.
 */
export const SQL_TYPE_RE = /^[A-Za-z][A-Za-z0-9_ ]*(\[\])?$/;

/**
 * What decodes an expression's driver value: a column (its own mapper), a
 * drizzle decoder, or a plain function (`Number`, `String`, sql-projection's
 * `parsed`) — exactly what drizzle's `SQL.mapWith()` accepts.
 */
// The `any`s are drizzle's own `mapWith` constraint, copied verbatim (as
// sql-projection's `SqlDecoderLike` does): narrowing them would reject a
// decoder `.mapWith` accepts.
export type ExprDecoder =
  | DriverValueDecoder<any, any>
  | DriverValueDecoder<any, any>["mapFromDriverValue"];

/**
 * An expression value's WIRE form — the structural subset of sql-column's
 * `WireCodec` (core cannot import that server barrel): what a stored value
 * becomes when the row crosses the JSON wire. Applied in JS per row, like a
 * `withWire` column's codec; never handed `null`.
 */
export interface ExprWire<Data, Wire> {
  schema: ZodParser<Wire>;
  encode: (value: Data) => Wire;
}

declare const exprValue: unique symbol;

/**
 * The runtime brand only {@link expr} sets — unexported, so an object literal
 * cannot spell an `ExprField` (tsc) and {@link isExprField} rejects one that
 * was cast into shape: every field reaching a compile went through `expr`'s
 * `sqlType` check.
 */
const EXPR_BRAND: unique symbol = Symbol("ExprField");

/**
 * A row field computed by a SQL expression (see the header). `V` is its value
 * type on the wire, which a binding site requires to be the row field's type.
 * Made by {@link expr} only: its brand is unexported, so a hand-built one is a
 * tsc error and fails {@link isExprField}.
 */
export interface ExprField<V = unknown> {
  readonly kind: "expr";
  /** Set by {@link expr} only — see `EXPR_BRAND`. */
  readonly [EXPR_BRAND]: true;
  /** The expression, over the binding's `j` (and declared server-only base columns). */
  readonly sql: SQL;
  readonly decoder: ExprDecoder;
  /** The SQL type the expression produces (checked against {@link SQL_TYPE_RE}). */
  readonly sqlType: string;
  /** Whether the expression can never be NULL (declared; `false` = it may be). */
  readonly notNull: boolean;
  /** The server-only base columns the expression reads beyond the wire columns. */
  readonly serverOnly: readonly PgColumn[];
  /** The stored value's wire form, when it cannot cross the JSON wire as is. */
  readonly wire: ExprWire<never, unknown> | undefined;
  /** Phantom: the value type (covariant). */
  readonly [exprValue]?: V;
}

type Nullable<V, NN> = NN extends true ? V : V | null;

interface ExprOptions<D extends ExprDecoder, NN extends boolean> {
  /** Decodes the driver value: its result type is the field's value type. */
  decoder: D;
  /** The SQL type the expression produces — what a cut's operand is cast to. */
  sqlType: string;
  /** `true` when the expression can never be NULL. Default `false` (`V | null`). */
  notNull?: NN;
  /**
   * Server-only base columns the expression reads (columns `j` does not
   * offer), named by the table's own column: declared, so a read of one is a
   * decision, not an accident. The VALUE still crosses the wire — declare
   * only what may be exposed through it.
   */
  serverOnly?: readonly PgColumn[];
}

/**
 * Declare a row field computed by `expression` — see the header. Throws on an
 * `sqlType` that is not a Postgres type name.
 */
export function expr<D extends ExprDecoder, W, NN extends boolean = false>(
  expression: SQL,
  opts: ExprOptions<D, NN> & { wire: ExprWire<GetDecoderResult<D>, W> },
): ExprField<Nullable<W, NN>>;
export function expr<D extends ExprDecoder, NN extends boolean = false>(
  expression: SQL,
  opts: ExprOptions<D, NN>,
): ExprField<Nullable<GetDecoderResult<D>, NN>>;
export function expr(
  expression: SQL,
  opts: ExprOptions<ExprDecoder, boolean> & {
    wire?: ExprWire<never, unknown>;
  },
): ExprField {
  if (!SQL_TYPE_RE.test(opts.sqlType)) {
    throw new Error(
      `expr: sqlType "${opts.sqlType}" is not a Postgres type name (${SQL_TYPE_RE.source}) — it is interpolated raw into casts.`,
    );
  }
  return Object.freeze({
    kind: "expr",
    [EXPR_BRAND]: true as const,
    sql: expression,
    decoder: opts.decoder,
    sqlType: opts.sqlType,
    notNull: opts.notNull === true,
    serverOnly: opts.serverOnly ?? [],
    wire: opts.wire,
  });
}

/**
 * Whether a field binding is an {@link ExprField} made by {@link expr} (and not
 * a column override). Reads the brand, never `kind`, so a forged object is not
 * one.
 */
export function isExprField(value: unknown): value is ExprField {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { [EXPR_BRAND]?: unknown })[EXPR_BRAND] === true
  );
}
