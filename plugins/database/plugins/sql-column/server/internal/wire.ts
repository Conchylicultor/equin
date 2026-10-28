/**
 * A column type's WIRE form: what one of its values becomes when a row crosses
 * the JSON wire to the browser.
 *
 * Most columns need nothing — a `text`, a number, a boolean or a timestamp is
 * already a JSON value (or one `JSON.stringify` makes, like a `Date`). A few
 * are not: a `bytea` comes back from `pg` as a `Buffer`, which JSON spells as
 * `{"type":"Buffer","data":[…]}`. Such a column type declares its wire form ONCE,
 * here, and everything that projects the column onto the wire
 * (`network/live`'s `serveCollection`) applies it — in JS, per row, never in SQL
 * (Postgres' `encode(…, 'base64')` folds lines at 76 characters).
 *
 * ```ts
 * const byteaType = customType<{ data: Uint8Array; driverData: Uint8Array }>({ … });
 * export const bytea = (name: string) =>
 *   withWire(byteaType(name), { schema: z.string(), encode: stateToBase64 });
 * ```
 *
 * The codec's wire type rides on the built column's TYPE (a phantom brand on its
 * `columnType`, which drizzle carries from the builder through `pgTable`), so a
 * consumer can demand that a row schema's field be the wire type — a field
 * typed as the stored bytes is a tsc error there. At runtime the codec is
 * recorded against the built column, which is what {@link columnWireCodec}
 * reads.
 */
import type { z } from "zod";
import type { PgColumn, PgColumnBuilderBase } from "drizzle-orm/pg-core";

export interface WireCodec<Data, Wire> {
  /** Parses the wire form — the schema a row schema's field for this column is. */
  schema: z.ZodType<Wire>;
  /** Stored value → wire value. Never handed `null`: a NULL stays `null` on the wire. */
  encode: (value: Data) => Wire;
}

declare const wireBrand: unique symbol;

/** The phantom brand carrying a column's wire type `W` (invariant in `W`). */
export interface WireBrand<W> {
  readonly [wireBrand]: (wire: W) => W;
}

/** A builder whose built column carries the wire type `W` on its `columnType`. */
export type WithWire<B extends PgColumnBuilderBase, W> = B & {
  _: { columnType: B["_"]["columnType"] & WireBrand<W> };
};

/**
 * The wire type of a built column's value, or `null` for a column that declares
 * none (its value crosses the wire as is). NULL-able columns add `| null`.
 */
export type ColumnWire<C> = C extends {
  _: { columnType: infer CT; notNull: infer NN };
}
  ? CT extends WireBrand<infer W>
    ? { wire: NN extends true ? W : W | null }
    : null
  : null;

const codecs = new WeakMap<PgColumn, WireCodec<unknown, unknown>>();

/**
 * Declare `codec` as the wire form of the column `builder` builds. Returns the
 * same builder (so `.notNull()` and the rest chain as before), with the wire
 * type on its type. Wrap it inside the column type's own factory, so every
 * column of that type gets it.
 */
export function withWire<B extends PgColumnBuilderBase, W>(
  builder: B,
  codec: WireCodec<B["_"]["data"], W>,
): WithWire<B, W> {
  // drizzle builds each column with `builder.build(table)` (`pgTable`), a
  // prototype method; shadowing it on this ONE builder records the codec
  // against the column it returns, whatever the builder chain did in between.
  const target = builder as unknown as { build: (table: unknown) => PgColumn };
  const build = target.build.bind(builder);
  target.build = (table) => {
    const column = build(table);
    codecs.set(column, codec as WireCodec<unknown, unknown>);
    return column;
  };
  return builder as WithWire<B, W>;
}

/**
 * The wire codec a built column declared through {@link withWire}, or
 * `undefined` for a column whose value crosses the wire as is — the common
 * case, not a failure.
 */
export function columnWireCodec(
  column: PgColumn,
): WireCodec<unknown, unknown> | undefined {
  return codecs.get(column);
}
