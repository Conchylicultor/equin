import { inspectV4, isV4Schema } from "./backend-v4";
import type {
  Schema,
  SchemaChild,
  SchemaKind,
  SchemaNode,
  SchemaNodeOf,
} from "./schema-node";

/** Is `value` a zod schema (what {@link inspect} reads)? */
export function isZodSchema(value: unknown): value is Schema {
  return isV4Schema(value);
}

/**
 * One level of `schema`, in the repo's model ({@link SchemaNode}). Anything
 * but a zod 4 schema THROWS — a value that is not a schema has no kind to
 * stand in for, and a zod 3 one (`zod/v3`, or a dependency's own zod 3) is
 * named as such.
 */
export function inspect(schema: unknown): SchemaNode {
  if (isV4Schema(schema)) return inspectV4(schema);
  throw new TypeError(
    `zod-introspect: inspect was handed ${describeValue(schema)}, not a zod 4 schema.`,
  );
}

function describeValue(value: unknown): string {
  if (value === null) return "null";
  if (isZod3Schema(value)) return "a zod 3 schema (`_def.typeName`)";
  if (typeof value !== "object") return `a ${typeof value}`;
  return `an object (${Object.prototype.toString.call(value)})`;
}

function isZod3Schema(value: unknown): boolean {
  if (typeof value !== "object" || value === null || !("_def" in value)) {
    return false;
  }
  const def: unknown = value._def;
  return (
    typeof def === "object" &&
    def !== null &&
    "typeName" in def &&
    typeof def.typeName === "string"
  );
}

/**
 * The schemas a node holds, each with the edge it hangs by, in a fixed
 * order: an object's keys (then its catchall), an array's / set's element, a
 * record's / map's key then value, a tuple's items (then its rest), a union's
 * options, an intersection's left then right, a pipe's in then out, a
 * wrapper's inner. Checks are not children (a refinement holds a function).
 */
export function childrenOf(node: SchemaNode): readonly SchemaChild[] {
  switch (node.kind) {
    case "object": {
      const out: SchemaChild[] = Object.entries(node.shape).map(
        ([key, schema]) => ({ edge: { kind: "key", key }, schema }),
      );
      if (typeof node.unknownKeys === "object") {
        out.push({
          edge: { kind: "catchall" },
          schema: node.unknownKeys.catchall,
        });
      }
      return out;
    }
    case "array":
    case "set":
      return [{ edge: { kind: "element" }, schema: node.element }];
    case "record":
    case "map":
      return [
        { edge: { kind: "keyType" }, schema: node.key },
        { edge: { kind: "valueType" }, schema: node.value },
      ];
    case "tuple": {
      const out: SchemaChild[] = node.items.map((schema, index) => ({
        edge: { kind: "item", index },
        schema,
      }));
      if (node.rest !== null)
        out.push({ edge: { kind: "rest" }, schema: node.rest });
      return out;
    }
    case "union":
      return node.options.map((schema, index) => ({
        edge: { kind: "option", index },
        schema,
      }));
    case "intersection":
      return [
        { edge: { kind: "left" }, schema: node.left },
        { edge: { kind: "right" }, schema: node.right },
      ];
    case "pipe":
      return [
        { edge: { kind: "in" }, schema: node.in },
        { edge: { kind: "out" }, schema: node.out },
      ];
    case "optional":
    case "nullable":
    case "readonly":
    case "nonoptional":
    case "catch":
    case "promise":
    case "success":
    case "lazy":
    case "default":
    case "prefault":
      return [{ edge: { kind: "inner" }, schema: node.inner }];
    case "string":
    case "number":
    case "bigint":
    case "boolean":
    case "date":
    case "symbol":
    case "undefined":
    case "null":
    case "void":
    case "never":
    case "any":
    case "unknown":
    case "nan":
    case "file":
    // A function's signature and a template literal's parts are not values
    // the schema holds: no children (describeSchema reads them off the node).
    case "function":
    case "template_literal":
    case "literal":
    case "enum":
    case "transform":
      return [];
    default: {
      const unknownNode: never = node;
      throw new Error(
        `zod-introspect: childrenOf a ${(unknownNode as SchemaNode).kind} node.`,
      );
    }
  }
}

/** The wrappers {@link peel} strips: each holds one inner schema and keeps its value's type. */
export type PeelableKind =
  | "optional"
  | "nullable"
  | "default"
  | "prefault"
  | "catch"
  | "readonly"
  | "nonoptional";

const PEELABLE: ReadonlySet<SchemaKind> = new Set<PeelableKind>([
  "optional",
  "nullable",
  "default",
  "prefault",
  "catch",
  "readonly",
  "nonoptional",
]);

/**
 * `schema` with its wrappers stripped — optional, nullable, default,
 * prefault, catch, readonly, nonoptional, however nested — and what was
 * stripped, outermost first. A brand is no wrapper (zod 4 has none); a pipe,
 * a lazy or a union is not peeled (take {@link valueSide} of a pipe).
 */
export function peel(schema: unknown): {
  node: SchemaNode;
  peeled: readonly PeelableKind[];
} {
  const peeled: PeelableKind[] = [];
  let node = inspect(schema);
  while (PEELABLE.has(node.kind)) {
    peeled.push(node.kind as PeelableKind);
    node = inspect((node as SchemaNodeOf<PeelableKind>).inner);
  }
  return { node, peeled };
}

/**
 * The side of a pipe whose schema describes its VALUE: `in` when `out` is a
 * transform (`.transform(fn)` — the function's output has no schema), else
 * `out` (`.pipe(s)`, and `z.preprocess(fn, s)`, whose `out` is `s`).
 */
export function valueSide(pipe: SchemaNodeOf<"pipe">): Schema {
  return inspect(pipe.out).kind === "transform" ? pipe.in : pipe.out;
}

/** The kinds {@link isUncheckedBase} counts as a base. */
const BASE_KINDS: ReadonlySet<SchemaKind> = new Set<SchemaKind>([
  "string",
  "number",
  "bigint",
  "boolean",
  "date",
  "any",
  "unknown",
]);

/**
 * Is `schema` a bare base — `z.string()`, `z.number()`, `z.boolean()`,
 * `z.bigint()`, `z.date()`, `z.any()`, `z.unknown()` — with NO check of any
 * kind (no size, format, refinement or rewrite) and no coercion? Then
 * parsing a value of its type checks nothing beyond that type. A brand is
 * transparent (`z.string().brand()` is bare); a wrapper is not (`.optional()`
 * accepts `undefined`).
 */
export function isUncheckedBase(schema: unknown): boolean {
  const node = inspect(schema);
  if (!BASE_KINDS.has(node.kind) || node.checks.length > 0) return false;
  return !("coerce" in node) || !node.coerce;
}
