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
 * and so is a `parsed` schema with an opaque part (`describeZodParts`).
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
      const { description, opaque } = describeZodParts(origin.schema);
      if (opaque.length > 0) {
        return fail(
          `${where}'s decoder is \`parsed(…, "${origin.label}")\` over a schema whose output depends on a function body (${opaque.join("; ")}) — the definition of a persisted compile could not move when that body does, so a value the old decoder produced would be served after a deploy (A18). Decode with a schema every part of which is data (a refinement is fine; a transform, preprocess, catch or computed default is not).`,
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

/** A JSON value a default may be recorded as: a scalar, an array or a plain object of them. */
function isJsonLiteral(value: unknown): boolean {
  if (value === null) return true;
  if (Array.isArray(value)) return value.every(isJsonLiteral);
  if (typeof value === "object") {
    return (
      Object.getPrototypeOf(value) === Object.prototype &&
      Object.values(value as object).every(isJsonLiteral)
    );
  }
  return (
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

/** The marker a part of a schema no description can see into is described as. */
const OPAQUE = "$opaque";

/**
 * A zod schema as data (zod 3's `_def`), and the parts of it the data cannot
 * pin. FAIL-CLOSED: a part whose OUTPUT depends on a function body — a
 * `transform` / `preprocess`, a `catch`, a `default` that is not one stable
 * JSON value — or a type this walk does not know is described by an
 * `{ $opaque: <what> }` marker and listed in `opaque`, never folded into a
 * description that would stay the same when its body changes. A refinement
 * is NOT opaque: it accepts or refuses a value, it never changes one.
 */
export function describeZodParts(schema: unknown): {
  description: unknown;
  opaque: readonly string[];
} {
  const opaque: string[] = [];
  const onStack = new Set<unknown>();
  const describe = (s: unknown, path: string): unknown => {
    const def = (s as { _def?: Record<string, unknown> } | null)?._def;
    const blind = (what: string): unknown => {
      opaque.push(`${path || "(root)"}: ${what}`);
      return { [OPAQUE]: what };
    };
    if (def === undefined) return blind(`a ${typeof s}, not a zod schema`);
    if (onStack.has(s)) return { recursive: String(def.typeName) };
    onStack.add(s);
    try {
      return describeDef(def, path, blind);
    } finally {
      onStack.delete(s);
    }
  };
  const describeDef = (
    def: Record<string, unknown>,
    path: string,
    blind: (what: string) => unknown,
  ): unknown => {
    const typeName = String(def.typeName);
    const at = (key: string, sub = key): unknown =>
      describe(def[key], `${path}/${sub}`);
    switch (typeName) {
      case "ZodObject": {
        const shape = (def.shape as () => Record<string, unknown>)();
        const catchall = def.catchall as { _def?: { typeName?: string } };
        return {
          object: Object.entries(shape).map(([k, v]) => [
            k,
            describe(v, `${path}/${k}`),
          ]),
          unknownKeys: def.unknownKeys ?? null,
          ...(catchall._def?.typeName === "ZodNever"
            ? {}
            : { catchall: at("catchall") }),
        };
      }
      case "ZodArray":
        return {
          array: at("type", "[]"),
          length: [def.minLength, def.maxLength, def.exactLength].map(
            (l) => (l as { value?: number } | null)?.value ?? null,
          ),
        };
      case "ZodSet":
        return {
          set: at("valueType", "[]"),
          size: [def.minSize, def.maxSize].map(
            (l) => (l as { value?: number } | null)?.value ?? null,
          ),
        };
      case "ZodMap":
        return { map: [at("keyType", "key"), at("valueType", "value")] };
      case "ZodNullable":
        return { nullable: at("innerType", "?") };
      case "ZodOptional":
        return { optional: at("innerType", "?") };
      case "ZodReadonly":
        return { readonly: at("innerType", "readonly") };
      case "ZodBranded":
        return { branded: at("type", "brand") };
      case "ZodDefault": {
        // zod wraps a literal default as `() => value`; call it twice, so a
        // default that is not one stable JSON value (a `Date`, a counter) is
        // told apart — and blinded — rather than recorded as one sample.
        const value = (def.defaultValue as () => unknown)();
        const again = (def.defaultValue as () => unknown)();
        const inner = at("innerType", "default");
        return isJsonLiteral(value) &&
          JSON.stringify(value) === JSON.stringify(again)
          ? { default: inner, value }
          : {
              default: inner,
              value: blind("a default that is not one JSON value"),
            };
      }
      case "ZodCatch":
        // zod wraps a literal catch value and a function reading the failed
        // input the same way: nothing tells them apart.
        return {
          catch: at("innerType", "catch"),
          value: blind("a catch value (a function of the failed input)"),
        };
      case "ZodLazy":
        return {
          lazy: describe((def.getter as () => unknown)(), `${path}/lazy`),
        };
      case "ZodEffects": {
        const effect = (def.effect as { type?: string } | undefined)?.type;
        const inner = at("schema", "effects");
        return effect === "refinement"
          ? { refinement: inner }
          : { effects: inner, fn: blind(`a ${effect ?? "unknown"} effect`) };
      }
      case "ZodPipeline":
        return { pipe: [at("in"), at("out")] };
      case "ZodUnion":
      case "ZodDiscriminatedUnion":
        return {
          union: [...(def.options as Iterable<unknown>)].map((o, i) =>
            describe(o, `${path}/|${i}`),
          ),
          ...(typeName === "ZodDiscriminatedUnion"
            ? { discriminator: def.discriminator }
            : {}),
        };
      case "ZodIntersection":
        return { intersection: [at("left"), at("right")] };
      case "ZodTuple":
        return {
          tuple: (def.items as unknown[]).map((item, i) =>
            describe(item, `${path}/${i}`),
          ),
          ...(def.rest === null || def.rest === undefined
            ? {}
            : { rest: at("rest") }),
        };
      case "ZodRecord":
        return { record: [at("keyType", "key"), at("valueType", "value")] };
      case "ZodEnum":
        return { enum: def.values };
      case "ZodNativeEnum":
        return { nativeEnum: Object.entries(def.values as object) };
      case "ZodLiteral":
        return isJsonLiteral(def.value)
          ? { literal: def.value }
          : { literal: blind("a literal that is not a JSON value") };
      case "ZodString":
      case "ZodNumber":
      case "ZodBigInt":
      case "ZodDate":
        return {
          [typeName]: (
            (def.checks as { kind: string }[] | undefined) ?? []
          ).map((c) =>
            JSON.stringify(c, (_k, v: unknown) =>
              v instanceof RegExp ? `/${v.source}/${v.flags}` : v,
            ),
          ),
          coerce: def.coerce === true,
        };
      // Fully described by their type name: no parameter, no function.
      case "ZodBoolean":
        return { ZodBoolean: [], coerce: def.coerce === true };
      case "ZodNull":
      case "ZodUndefined":
      case "ZodAny":
      case "ZodUnknown":
      case "ZodNever":
      case "ZodVoid":
      case "ZodNaN":
      case "ZodSymbol":
        return typeName;
      default:
        return blind(`an unhandled ${typeName}`);
    }
  };
  return { description: describe(schema, ""), opaque };
}

/** A zod schema as data — {@link describeZodParts}' description, opaque parts marked. */
export function describeZod(schema: unknown): unknown {
  return describeZodParts(schema).description;
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
