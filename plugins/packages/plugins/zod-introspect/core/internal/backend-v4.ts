import type { core } from "zod";
import type {
  FormatParam,
  Schema,
  SchemaCheck,
  SchemaNode,
  UnknownKeys,
} from "./schema-node";

// zod 4 (`_zod.def.type`) → SchemaNode. Read against zod's core
// (node_modules/zod/src/v4/core/{schemas,checks,api}.ts). Type-only imports:
// this backend reads schemas, it builds none.
//
// The model IS zod 4's, so the reads are direct; the few normalisations:
// a string / number / bigint format schema (`z.email()`, `z.int()`) carries
// its own format as a check on its def — read as its first check; `custom`
// (`z.custom`, `z.instanceof`) is `any` plus a `refine` check, as zod 3
// spells it; a set's `size_equals` is `min` + `max` (zod 3 cannot tell it
// apart); a catchall of `unknown` / `any` is `unknownKeys: "opaque"`.

type AnyDef = core.$ZodTypeDef & Record<string, unknown>;
interface V4Schema {
  readonly _zod: {
    readonly def: AnyDef;
    readonly bag: Record<string, unknown>;
    readonly constr: new (def: AnyDef) => V4Schema;
  };
}

/** Is `value` a zod 4 schema (`_zod.def.type` a string)? */
export function isV4Schema(value: unknown): value is V4Schema {
  if (typeof value !== "object" || value === null || !("_zod" in value)) {
    return false;
  }
  const internals: unknown = value._zod;
  if (
    typeof internals !== "object" ||
    internals === null ||
    !("def" in internals)
  ) {
    return false;
  }
  const def: unknown = internals.def;
  return (
    typeof def === "object" &&
    def !== null &&
    "type" in def &&
    typeof def.type === "string"
  );
}

function child(value: unknown, where: string): Schema {
  if (!isV4Schema(value)) {
    throw new Error(
      `zod-introspect: a zod 4 ${where} that is not a zod 4 schema (${typeof value}).`,
    );
  }
  return value;
}

export function inspectV4(schema: V4Schema): SchemaNode {
  const def = schema._zod.def;
  const checks = checksOf(def);
  const kind = def.type;
  switch (kind) {
    case "string":
      return {
        kind: "string",
        schema,
        checks,
        coerce: def.coerce === true,
        max: capOf(checks),
      };
    case "number":
    case "int":
      return { kind: "number", schema, checks, coerce: def.coerce === true };
    case "bigint":
    case "boolean":
    case "date":
      return { kind, schema, checks, coerce: def.coerce === true };
    case "symbol":
    case "undefined":
    case "null":
    case "void":
    case "never":
    case "any":
    case "unknown":
    case "nan":
    case "file":
      return { kind, schema, checks };
    case "template_literal":
      return {
        kind: "template_literal",
        schema,
        checks,
        parts: (def as unknown as core.$ZodTemplateLiteralDef).parts.map(
          (p, i) =>
            typeof p === "object" && p !== null
              ? child(p, `template literal part ${i}`)
              : p,
        ),
      };
    case "function": {
      const d = def as unknown as core.$ZodFunctionDef;
      return {
        kind: "function",
        schema,
        checks,
        input: child(d.input, "function input"),
        output: child(d.output, "function output"),
      };
    }
    case "custom":
      // `z.custom(fn)` / `z.instanceof(C)`: zod 3's `z.any().superRefine(fn)`.
      return { kind: "any", schema, checks: [...checks, { kind: "refine" }] };
    case "literal":
      return {
        kind: "literal",
        schema,
        checks,
        values: (def as unknown as core.$ZodLiteralDef<core.util.Literal>)
          .values,
      };
    case "enum":
      return {
        kind: "enum",
        schema,
        checks,
        ...enumEntries((def as unknown as core.$ZodEnumDef).entries),
      };
    case "array":
      return {
        kind: "array",
        schema,
        checks,
        element: child(
          (def as unknown as core.$ZodArrayDef).element,
          "array element",
        ),
        max: capOf(checks),
      };
    case "set":
      return {
        kind: "set",
        schema,
        checks,
        element: child(
          (def as unknown as core.$ZodSetDef).valueType,
          "set element",
        ),
        max: capOf(checks),
      };
    case "object": {
      const d = def as unknown as core.$ZodObjectDef;
      return {
        kind: "object",
        schema,
        checks,
        shape: Object.fromEntries(
          Object.entries(d.shape).map(([k, v]) => [k, child(v, `key "${k}"`)]),
        ),
        unknownKeys: unknownKeysOf(d.catchall),
      };
    }
    case "record": {
      const d = def as unknown as core.$ZodRecordDef;
      return {
        kind: "record",
        schema,
        checks,
        key: child(d.keyType, "key type"),
        value: child(d.valueType, "value type"),
        mode: d.mode ?? "strict",
        partial: d.partial === true,
      };
    }
    case "map": {
      const d = def as unknown as core.$ZodMapDef;
      return {
        kind: "map",
        schema,
        checks,
        key: child(d.keyType, "key type"),
        value: child(d.valueType, "value type"),
        max: capOf(checks),
      };
    }
    case "tuple": {
      const d = def as unknown as core.$ZodTupleDef;
      return {
        kind: "tuple",
        schema,
        checks,
        items: d.items.map((s, i) => child(s, `tuple item ${i}`)),
        rest: d.rest === null ? null : child(d.rest, "tuple rest"),
      };
    }
    case "union": {
      const d = def as unknown as core.$ZodUnionDef & {
        discriminator?: string;
        unionFallback?: boolean;
      };
      return {
        kind: "union",
        schema,
        checks,
        options: d.options.map((o, i) => child(o, `union option ${i}`)),
        discriminator: d.discriminator,
        inclusive: d.inclusive !== false,
        unionFallback: d.unionFallback === true,
      };
    }
    case "intersection": {
      const d = def as unknown as core.$ZodIntersectionDef;
      return {
        kind: "intersection",
        schema,
        checks,
        left: child(d.left, "intersection left"),
        right: child(d.right, "intersection right"),
      };
    }
    case "pipe": {
      const d = def as unknown as core.$ZodPipeDef;
      return {
        kind: "pipe",
        schema,
        checks,
        in: child(d.in, "pipe in"),
        out: child(d.out, "pipe out"),
        // A codec is a pipe whose def holds its decode function.
        codec: typeof d.transform === "function",
      };
    }
    case "transform":
      return { kind: "transform", schema, checks };
    case "default":
    case "prefault": {
      // `defaultValue` is a getter on the def: each read is one fill.
      const d = def as unknown as core.$ZodDefaultDef | core.$ZodPrefaultDef;
      return {
        kind,
        schema,
        checks,
        inner: child(d.innerType, "inner type"),
        defaultValue: () => d.defaultValue,
      };
    }
    case "optional":
    case "nullable":
    case "readonly":
    case "nonoptional":
    case "catch":
    case "promise":
    case "success":
      return {
        kind,
        schema,
        checks,
        inner: child(
          (def as unknown as { innerType: unknown }).innerType,
          "inner type",
        ),
      };
    case "lazy":
      return {
        kind: "lazy",
        schema,
        checks,
        inner: child(
          (def as unknown as core.$ZodLazyDef).getter(),
          "lazy getter",
        ),
      };
    default: {
      const unknownKind: never = kind;
      throw new Error(
        `zod-introspect: a zod 4 "${String(unknownKind)}" schema, a kind this backend does not know — teach backend-v4.ts.`,
      );
    }
  }
}

/**
 * The size cap the checks state: the least `max` / `exact` size bound. Read
 * off the checks, not `_zod.bag.maximum` — zod 4.6's length checks no longer
 * record one there.
 */
function capOf(checks: readonly SchemaCheck[]): number | undefined {
  let cap: number | undefined;
  for (const c of checks) {
    if (c.kind !== "size" || c.bound === "min") continue;
    if (cap === undefined || c.value < cap) cap = c.value;
  }
  return cap;
}

function unknownKeysOf(catchall: unknown): UnknownKeys {
  if (catchall === undefined) return "strip";
  const schema = child(catchall, "catchall") as V4Schema;
  const kind = schema._zod.def.type;
  if (kind === "never") return "strict";
  if (kind === "unknown" || kind === "any") return "opaque";
  return { catchall: schema };
}

type CheckDef = core.$ZodCheckDef & Record<string, unknown>;

/** A def's checks, its own format first when it is a format schema (`z.email()`). */
function checksOf(def: AnyDef): SchemaCheck[] {
  const out: SchemaCheck[] = [];
  if (typeof def.check === "string" && def.type !== "custom") {
    out.push(...normaliseCheck(def as unknown as CheckDef));
  }
  for (const c of def.checks ?? []) {
    out.push(
      ...normaliseCheck((c as unknown as { _zod: { def: CheckDef } })._zod.def),
    );
  }
  return out;
}

function normaliseCheck(c: CheckDef): SchemaCheck[] {
  switch (c.check) {
    case "less_than":
    case "greater_than":
      return [
        {
          kind: "range",
          bound: c.check === "less_than" ? "max" : "min",
          value: numeric(c.value),
          inclusive: c.inclusive as boolean,
        },
      ];
    case "multiple_of":
      return [{ kind: "multipleOf", value: c.value as number | bigint }];
    case "number_format":
    case "bigint_format":
      return [{ kind: "numberFormat", format: c.format as string }];
    case "min_length":
    case "min_size":
      return [{ kind: "size", bound: "min", value: c.minimum as number }];
    case "max_length":
    case "max_size":
      return [{ kind: "size", bound: "max", value: c.maximum as number }];
    case "length_equals":
      return [{ kind: "size", bound: "exact", value: c.length as number }];
    case "size_equals":
      return [
        { kind: "size", bound: "min", value: c.size as number },
        { kind: "size", bound: "max", value: c.size as number },
      ];
    case "string_format": {
      const format: SchemaCheck = {
        kind: "format",
        format: c.format as string,
        params: formatParams(c),
        // `url` trims its value (and with `normalize` replaces it by `url.href`).
        rewrites: c.format === "url",
      };
      // A custom format's own test (`z.stringFormat(name, fn)`); one built
      // from a regex is stated by its `pattern`.
      return typeof c.fn === "function" && c.pattern === undefined
        ? [format, { kind: "refine" }]
        : [format];
    }
    case "mime_type":
      return [{ kind: "mimeType", mime: c.mime as string[] }];
    case "overwrite":
      return [{ kind: "rewrite" }];
    case "custom":
    case "property":
      // `property` tests one key of the value against a schema: a test.
      return [{ kind: "refine" }];
    default:
      throw new Error(
        `zod-introspect: a zod 4 "${c.check}" check, which this backend does not know — teach backend-v4.ts.`,
      );
  }
}

/** A range bound as a number (a date's as its epoch milliseconds). */
function numeric(value: unknown): number | bigint {
  return value instanceof Date ? value.getTime() : (value as number | bigint);
}

/**
 * The parameters of a string format that change what it accepts or produces:
 * its `pattern` (every format zod gives one carries it — a built-in's, a
 * `z.email({ pattern })` / `.regex()` / `z.stringFormat(name, regex)` one),
 * plus each format's own.
 */
function formatParams(c: CheckDef): Readonly<Record<string, FormatParam>> {
  const pick = (...keys: string[]): Record<string, FormatParam> => {
    const out: Record<string, FormatParam> = {};
    for (const k of ["pattern", ...keys]) {
      const v = c[k];
      if (v === undefined) continue;
      out[k] = v instanceof RegExp ? String(v) : (v as FormatParam);
    }
    return out;
  };
  switch (c.format) {
    case "includes":
      return pick("includes", "position");
    case "starts_with":
      return pick("prefix");
    case "ends_with":
      return pick("suffix");
    case "datetime":
      return pick("precision", "offset", "local");
    case "time":
      return {
        ...pick(),
        precision: (c.precision as number | null | undefined) ?? null,
      };
    case "uuid":
      return pick("version");
    case "jwt":
      return pick("alg");
    case "url":
      return pick("hostname", "protocol", "normalize");
    default:
      return pick();
  }
}

/**
 * An enum object's entries as zod 4 reads them (`util.getEnumValues`): a key
 * that is a numeric value's reverse mapping (`{ A: 1, "1": "A" }`) dropped.
 */
function enumEntries(raw: unknown): {
  entries: Readonly<Record<string, string | number>>;
  values: readonly (string | number)[];
} {
  const obj = raw as Record<string, string | number>;
  const numeric = Object.values(obj).filter((v) => typeof v === "number");
  const entries = Object.fromEntries(
    Object.entries(obj).filter(([k]) => !numeric.includes(Number(k))),
  );
  return { entries, values: Object.values(entries) };
}

// --- tags -------------------------------------------------------------------

/** The def a tag lives on: the schema's own. */
export function v4TagDef(schema: V4Schema): Record<string, unknown> {
  return schema._zod.def;
}

/**
 * `schema` cloned over a new def holding `key: value` — never the source's def
 * mutated: `.describe()` / `.meta()` clone over the SAME def object, so a
 * mutation would tag every schema sharing it. Registry metadata
 * (`.describe()` / `.meta()`) is carried over, minus an `id` (the registry
 * refuses a second schema under one id).
 */
export function v4WithTag(
  schema: V4Schema,
  key: string,
  value: unknown,
): Schema {
  // Copied by descriptor, as zod's own `mergeDefs` does: a spread would
  // evaluate an accessor — a default's `get defaultValue()`, which makes a
  // fresh fill per read — into one value every parse then shares.
  const def = Object.defineProperties(
    {},
    {
      ...Object.getOwnPropertyDescriptors(schema._zod.def),
      [key]: { value, enumerable: true, writable: true, configurable: true },
    },
  ) as AnyDef;
  const cl = new schema._zod.constr(def);
  const meta = (schema as { meta?: () => unknown }).meta?.();
  if (meta === undefined || meta === null) return cl;
  const { id: _id, ...rest } = meta as Record<string, unknown>;
  return (cl as unknown as { meta: (m: unknown) => Schema }).meta(rest);
}
