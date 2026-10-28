import { sha256Hex } from "@plugins/packages/plugins/string-hash/core";
import { Column, getTableName, is, type SQL } from "drizzle-orm";
import { PgDialect, type PgColumn } from "drizzle-orm/pg-core";
import type { Rollup } from "@plugins/database/plugins/derived-tables/core";
import {
  decoderOrigin,
  type SqlDecoderLike,
} from "@plugins/database/plugins/sql-projection/server";
import { columnSchema } from "@plugins/database/plugins/sql-column/server";
import { jsonAggValue } from "@plugins/infra/plugins/query-resource/core";
import { describeSchema } from "@plugins/packages/plugins/zod-introspect/core";

// The L2 DEFINITION of a persisted compile (A18 of
// research/2026-10-01-global-scoped-change-routing-p5-p8-v2.md; A40): a
// sha256 over everything that decides the value a load produces — its SQL as
// the database receives it (rendered through drizzle's own `PgDialect`, text
// and params), how each field is decoded, the row schema, the wire codecs,
// the DDL of every rollup it reads, and its order. A persisted row written
// under another definition is not served (live-state-snapshot's read
// predicate), so a code change that moves any of these never serves a value
// the old code computed.
//
// Deterministic across processes by construction: nothing here reads an
// object identity, a function's source or a clock. A param that is not a
// literal (a `Date`, an object) is refused — its rendering is not data the
// definition could pin (A40).

const dialect = new PgDialect();

/** A SQL fragment as the database receives it. */
export interface RenderedQuery {
  sql: string;
  params: unknown[];
}

/** A JSON literal a param may be: a scalar, or an array of them. */
function isLiteral(value: unknown): boolean {
  if (value === null) return true;
  if (Array.isArray(value)) return value.every(isLiteral);
  return (
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

/**
 * Render `query` through drizzle's dialect — what the compile sends. Throws
 * (A40) on a param that is not a literal: a JS value whose rendering a
 * definition could not pin.
 */
export function renderQuery(
  query: SQL,
  label: string,
  fail: (message: string) => never,
): RenderedQuery {
  const out = dialect.sqlToQuery(query);
  for (const [i, param] of out.params.entries()) {
    if (!isLiteral(param)) {
      fail(
        `${label}: param $${i + 1} is ${Object.prototype.toString.call(param)}, not a literal — the definition of a persisted compile must not depend on a JS value's rendering (A40). Write it into the SQL as a literal.`,
      );
    }
  }
  return { sql: out.sql, params: out.params };
}

/**
 * A field decoder as data (A18): a column's (by its table, name and column
 * type — and, for a `parsedText` / `parsedJson` column, `describeZod` of the
 * schema it decodes through, sql-column's `columnSchema`), a native
 * coercion's name, a `parsed` decoder's label and schema (`describeZod`), a
 * `nullable` one's inner decoder, or `jsonAgg`'s — read through
 * sql-projection's `decoderOrigin`, never a function's identity or source.
 * Any other function is OPAQUE: a change to its body could not move the
 * definition, so a persisted compile refuses it (`fail`, naming `where`) —
 * and so is a `parsed` schema with an opaque part (`describeSchema`'s
 * `opaque`).
 */
export function decoderId(
  decoder: SqlDecoderLike,
  where: string,
  fail: (message: string) => never,
): string {
  // `.mapWith(fn)` stores `{ mapFromDriverValue: fn }`.
  const held = is(decoder, Column)
    ? decoder
    : typeof decoder === "function"
      ? decoder
      : (decoder as { mapFromDriverValue: unknown }).mapFromDriverValue;
  if (held === jsonAggValue) return "jsonAgg";
  const origin = decoderOrigin(decoder);
  switch (origin.kind) {
    case "column": {
      const col = origin.column as PgColumn;
      // A `parsedText` / `parsedJson` column decodes through its schema: a
      // change to it moves what a read produces, its name and type unmoved.
      const schema = columnSchema(col);
      return `column:${getTableName(col.table)}.${col.name}:${col.columnType}:${col.getSQLType()}${
        schema === undefined ? "" : `:${JSON.stringify(describeZod(schema))}`
      }`;
    }
    case "builtin":
      return `builtin:${origin.name}`;
    case "parsed": {
      const { description, opaque } = describeSchema(origin.schema);
      if (opaque.length > 0) {
        return fail(
          `${where}'s decoder is \`parsed(…, "${origin.label}")\` over a schema whose output depends on a function body (${opaque.join("; ")}) — the definition of a persisted compile could not move when that body does, so a value the old decoder produced would be served after a deploy (A18). Decode with a schema every part of which is data (a refinement is fine; a transform, preprocess, rewrite check such as \`.trim()\`, catch or computed default is not).`,
        );
      }
      return `parsed:${JSON.stringify([origin.label, description])}`;
    }
    case "nullable":
      return `nullable:${decoderId(origin.inner, where, fail)}`;
    case "opaque":
      return fail(
        `${where}'s decoder is a function with no readable identity — the definition of a persisted compile could not move when its body does, so a value the old decoder produced would be served after a deploy (A18). Decode with a column, \`Number\` / \`String\` / \`Boolean\` / \`BigInt\`, \`parsed(schema, label)\`, or \`nullable(…)\` of one.`,
      );
  }
}

/**
 * A zod schema as data — zod-introspect's `describeSchema` description, read
 * off its normalised `SchemaNode`s and never off zod's own def layout, so a zod
 * upgrade that keeps the `SchemaNode` model cannot move a definition.
 * FAIL-CLOSED: a part whose output depends on a function body (a transform —
 * and so a preprocess —, a codec, a rewrite check, a catch, a default that is
 * not one stable JSON value) is an `{ $opaque }` marker, folded in; a
 * refinement is data. Throws on anything but a zod 4 schema (a zod 3 one is
 * refused by name).
 */
export function describeZod(schema: unknown): unknown {
  return describeSchema(schema).description;
}

/** The DDL of a rollup, hashed: its table, and each source's maintain function and triggers. */
export function rollupDdlHash(rollup: Rollup): string {
  return sha256(
    JSON.stringify([
      rollup.table,
      rollup.createTableDdl,
      rollup.selectCheckSql,
      rollup.sources.map((s) => [
        s.table,
        s.functionDdl,
        s.triggers.map((t) => t.ddl),
      ]),
    ]),
  );
}

export function sha256(text: string): string {
  return sha256Hex(text);
}
