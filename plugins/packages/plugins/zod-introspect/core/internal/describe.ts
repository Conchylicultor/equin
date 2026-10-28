import { childrenOf, inspect } from "./inspect";
import type { SchemaCheck, SchemaEdge, SchemaNode } from "./schema-node";

/** The marker a part no description can see into is described as. */
export const OPAQUE_MARK = "$opaque";

/** What {@link describeSchema} returns. */
export interface SchemaDescription {
  /** The schema as JSON-safe data. */
  readonly description: unknown;
  /** Each part described as `{ $opaque: what }`, as `<path>: <what>` (`/a/[]: a transform`). */
  readonly opaque: readonly string[];
}

/**
 * A schema as data, from its {@link SchemaNode}s — never from zod's own def
 * layout, so the description survives a zod upgrade, and moves only when what the schema accepts or produces does.
 *
 * FAIL-CLOSED: a part whose OUTPUT depends on a function body — a transform
 * (and so a preprocess), a codec (`z.codec`, `z.stringbool()`), a rewrite check (`.trim()` — zod 4 cannot say which
 * rewrite it is), a catch value, a default or literal that is not one stable
 * JSON value — is described as `{ $opaque: <what> }` and listed in `opaque`,
 * never folded into a description that would stay the same when the body
 * changes. A refinement is NOT opaque: it accepts or refuses a value, it never
 * changes one. A recursion (through `lazy`) is `{ recursive: <kind> }`.
 *
 * Each node is `{ kind, …its fields, checks }` — children described in
 * place, an object's shape and an enum's entries as `[key, …]` pairs in
 * declaration order, a bigint as `{ bigint: "<digits>" }`.
 */
export function describeSchema(schema: unknown): SchemaDescription {
  const opaque: string[] = [];
  const onStack = new Set<unknown>();

  const describe = (s: unknown, path: string): unknown => {
    const node = inspect(s);
    if (onStack.has(node.schema)) return { recursive: node.kind };
    onStack.add(node.schema);
    try {
      return describeNode(node, path);
    } finally {
      onStack.delete(node.schema);
    }
  };

  const blind = (path: string, what: string): unknown => {
    opaque.push(`${path || "(root)"}: ${what}`);
    return { [OPAQUE_MARK]: what };
  };

  const describeNode = (node: SchemaNode, path: string): unknown => {
    const kids = new Map<string, unknown>();
    for (const c of childrenOf(node)) {
      kids.set(
        edgeKey(c.edge),
        describe(c.schema, path + edgeSegment(c.edge, node)),
      );
    }
    const kid = (edge: SchemaEdge): unknown => kids.get(edgeKey(edge));
    const checks = node.checks.map((c) => describeCheck(c, path, blind));
    switch (node.kind) {
      case "string":
      case "number":
      case "bigint":
      case "boolean":
      case "date":
        return { kind: node.kind, coerce: node.coerce, checks };
      case "literal":
        return {
          kind: "literal",
          values: node.values.map((v) =>
            isJsonValue(v)
              ? v
              : blind(path, "a literal that is not a JSON value"),
          ),
          checks,
        };
      case "enum":
        return { kind: "enum", entries: Object.entries(node.entries), checks };
      case "object":
        return {
          kind: "object",
          shape: Object.keys(node.shape).map((key) => [
            key,
            kid({ kind: "key", key }),
          ]),
          unknownKeys:
            typeof node.unknownKeys === "string"
              ? node.unknownKeys
              : { catchall: kid({ kind: "catchall" }) },
          checks,
        };
      case "array":
      case "set":
        return { kind: node.kind, element: kid({ kind: "element" }), checks };
      case "record":
        return {
          kind: "record",
          key: kid({ kind: "keyType" }),
          value: kid({ kind: "valueType" }),
          mode: node.mode,
          partial: node.partial,
          checks,
        };
      case "map":
        return {
          kind: "map",
          key: kid({ kind: "keyType" }),
          value: kid({ kind: "valueType" }),
          checks,
        };
      case "tuple":
        return {
          kind: "tuple",
          items: node.items.map((_, index) => kid({ kind: "item", index })),
          rest: node.rest === null ? null : kid({ kind: "rest" }),
          checks,
        };
      case "union":
        return {
          kind: "union",
          options: node.options.map((_, index) =>
            kid({ kind: "option", index }),
          ),
          discriminator: node.discriminator ?? null,
          inclusive: node.inclusive,
          unionFallback: node.unionFallback,
          checks,
        };
      case "intersection":
        return {
          kind: "intersection",
          left: kid({ kind: "left" }),
          right: kid({ kind: "right" }),
          checks,
        };
      case "pipe":
        return {
          kind: "pipe",
          in: kid({ kind: "in" }),
          out: kid({ kind: "out" }),
          // A codec's decode is a function body between `in` and `out`.
          ...(node.codec ? { codec: blind(path, "a codec transform") } : {}),
          checks,
        };
      case "template_literal":
        // Its parts are no children (pieces of one string), described here.
        return {
          kind: "template_literal",
          parts: node.parts.map((part, i) =>
            typeof part === "object" && part !== null
              ? describe(part, `${path}/\`${i}`)
              : part === undefined
                ? { undefined: true }
                : typeof part === "bigint"
                  ? { bigint: part.toString() }
                  : part,
          ),
          checks,
        };
      case "function":
        // Its signature is no child (not a value it holds), described here.
        return {
          kind: "function",
          input: describe(node.input, `${path}/(in)`),
          output: describe(node.output, `${path}/(out)`),
          checks,
        };
      case "transform":
        return { kind: "transform", fn: blind(path, "a transform"), checks };
      case "default":
      case "prefault": {
        // Read twice, so a default that is not one stable JSON value (a
        // `Date`, a counter) is told apart — and blinded — rather than
        // recorded as one sample.
        const value = node.defaultValue();
        const again = node.defaultValue();
        return {
          kind: node.kind,
          inner: kid({ kind: "inner" }),
          value:
            isJsonValue(value) &&
            JSON.stringify(value) === JSON.stringify(again)
              ? value
              : blind(path, `a ${node.kind} that is not one JSON value`),
          checks,
        };
      }
      case "catch":
        // A literal catch value and a function of the failed input look alike.
        return {
          kind: "catch",
          inner: kid({ kind: "inner" }),
          value: blind(path, "a catch value (a function of the failed input)"),
          checks,
        };
      case "optional":
      case "nullable":
      case "readonly":
      case "nonoptional":
      case "promise":
      case "success":
      case "lazy":
        return { kind: node.kind, inner: kid({ kind: "inner" }), checks };
      case "symbol":
      case "undefined":
      case "null":
      case "void":
      case "never":
      case "any":
      case "unknown":
      case "nan":
      case "file":
        return { kind: node.kind, checks };
      default: {
        const unknownNode: never = node;
        throw new Error(
          `describeSchema: a ${(unknownNode as SchemaNode).kind} node.`,
        );
      }
    }
  };

  return { description: describe(schema, ""), opaque };
}

function describeCheck(
  c: SchemaCheck,
  path: string,
  blind: (path: string, what: string) => unknown,
): unknown {
  switch (c.kind) {
    case "range":
      return { ...c, value: jsonNumber(c.value) };
    case "multipleOf":
      return { ...c, value: jsonNumber(c.value) };
    case "rewrite":
      return { kind: "rewrite", fn: blind(path, "a rewrite check") };
    case "size":
    case "numberFormat":
    case "format":
    case "mimeType":
    case "refine":
      return c;
    default: {
      const unknownCheck: never = c;
      throw new Error(
        `describeSchema: a ${(unknownCheck as SchemaCheck).kind} check.`,
      );
    }
  }
}

function jsonNumber(value: number | bigint): unknown {
  return typeof value === "bigint" ? { bigint: value.toString() } : value;
}

function edgeKey(edge: SchemaEdge): string {
  if (edge.kind === "key") return `key:${edge.key}`;
  if (edge.kind === "item" || edge.kind === "option") {
    return `${edge.kind}:${edge.index}`;
  }
  return edge.kind;
}

/** A path segment, for the `opaque` list: `/a`, `/[]`, `/{}`, `/0`, `/|1`, `/optional`. */
function edgeSegment(edge: SchemaEdge, parent: SchemaNode): string {
  switch (edge.kind) {
    case "key":
      return `/${edge.key}`;
    case "catchall":
    case "valueType":
      return "/{}";
    case "keyType":
      return "/{key}";
    case "element":
      return "/[]";
    case "item":
      return `/${edge.index}`;
    case "rest":
      return "/...";
    case "option":
      return `/|${edge.index}`;
    case "left":
      return "/&0";
    case "right":
      return "/&1";
    case "in":
      return "/in";
    case "out":
      return "/out";
    case "inner":
      return `/${parent.kind}`;
    default: {
      const unknownEdge: never = edge;
      throw new Error(
        `describeSchema: an edge ${JSON.stringify(unknownEdge)}.`,
      );
    }
  }
}

/** A JSON value: a scalar (a finite number), an array or a plain object of them. */
function isJsonValue(value: unknown): boolean {
  if (value === null) return true;
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (typeof value === "object") {
    return (
      Object.getPrototypeOf(value) === Object.prototype &&
      Object.values(value as object).every(isJsonValue)
    );
  }
  return (
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  );
}
