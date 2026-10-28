import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { describeSchema } from "./describe";
import {
  childrenOf,
  inspect,
  isUncheckedBase,
  isZodSchema,
  peel,
  valueSide,
} from "./inspect";
import type { FormatParam, SchemaNode, SchemaNodeOf } from "./schema-node";

// Every case is compared as `describeSchema`'s description, which is the node
// tree with the schema references resolved.

type Z = typeof z;

const str = (checks: unknown[] = [], coerce = false) => ({
  kind: "string",
  coerce,
  checks,
});
const num = (checks: unknown[] = [], coerce = false) => ({
  kind: "number",
  coerce,
  checks,
});
const leaf = (kind: string) => ({ kind, checks: [] });
// Every format zod gives a pattern carries it (a built-in's own regex — any
// string here); a url has none, and rewrites its value.
const fmt = (format: string, params: Record<string, FormatParam> = {}) => ({
  kind: "format" as const,
  format,
  params:
    format === "url" || "pattern" in params
      ? params
      : { pattern: expect.any(String), ...params },
  rewrites: format === "url",
});
const size = (bound: string, value: number) => ({ kind: "size", bound, value });
const range = (bound: string, value: unknown, inclusive: boolean) => ({
  kind: "range",
  bound,
  value,
  inclusive,
});
const REFINE = { kind: "refine" };
const opaque = (what: string) => ({ $opaque: what });
const REWRITE = { kind: "rewrite", fn: opaque("a rewrite check") };

enum Color {
  Red = "red",
  Green = "green",
}
enum Level {
  Low = 1,
  High = 2,
}

const CASES: readonly (readonly [string, (z: Z) => unknown, unknown])[] = [
  ["a bare string", (z) => z.string(), str()],
  ["a coerced number", (z) => z.coerce.number(), num([], true)],
  [
    "a coerced date",
    (z) => z.coerce.date(),
    { kind: "date", coerce: true, checks: [] },
  ],
  [
    "string sizes",
    (z) => z.string().min(1).max(5),
    str([size("min", 1), size("max", 5)]),
  ],
  ["string length", (z) => z.string().length(3), str([size("exact", 3)])],
  [
    "string formats",
    (z) => z.string().email().uuid().url(),
    str([fmt("email"), fmt("uuid"), fmt("url")]),
  ],
  [
    "a regex",
    (z) => z.string().regex(/^a+$/i),
    str([fmt("regex", { pattern: "/^a+$/i" })]),
  ],
  [
    "starts / ends / includes",
    (z) =>
      z.string().startsWith("a").endsWith("z").includes("m", { position: 2 }),
    str([
      fmt("starts_with", { prefix: "a" }),
      fmt("ends_with", { suffix: "z" }),
      fmt("includes", { includes: "m", position: 2 }),
    ]),
  ],
  [
    "a datetime",
    (z) => z.string().datetime({ offset: true, precision: 3 }),
    str([fmt("datetime", { precision: 3, offset: true, local: false })]),
  ],
  [
    "the rewrite checks",
    (z) => z.string().trim().toLowerCase().toUpperCase(),
    str([REWRITE, REWRITE, REWRITE]),
  ],
  [
    "number bounds and int",
    (z) => z.number().int().positive().lte(10).multipleOf(2),
    num([
      { kind: "numberFormat", format: "safeint" },
      range("min", 0, false),
      range("max", 10, true),
      { kind: "multipleOf", value: 2 },
    ]),
  ],
  ["finite is no check", (z) => z.number().finite(), num()],
  [
    "bigint bounds",
    (z) => z.bigint().min(1n),
    {
      kind: "bigint",
      coerce: false,
      checks: [range("min", { bigint: "1" }, true)],
    },
  ],
  [
    "date bounds",
    (z) => z.date().min(new Date(1000)),
    { kind: "date", coerce: false, checks: [range("min", 1000, true)] },
  ],
  [
    "boolean",
    (z) => z.boolean(),
    { kind: "boolean", coerce: false, checks: [] },
  ],
  ["null", (z) => z.null(), leaf("null")],
  ["undefined", (z) => z.undefined(), leaf("undefined")],
  ["any", (z) => z.any(), leaf("any")],
  ["unknown", (z) => z.unknown(), leaf("unknown")],
  ["never", (z) => z.never(), leaf("never")],
  ["void", (z) => z.void(), leaf("void")],
  ["nan", (z) => z.nan(), leaf("nan")],
  ["symbol", (z) => z.symbol(), leaf("symbol")],
  [
    "a literal",
    (z) => z.literal("a"),
    { kind: "literal", values: ["a"], checks: [] },
  ],
  [
    "an enum",
    (z) => z.enum(["a", "b"]),
    {
      kind: "enum",
      entries: [
        ["a", "a"],
        ["b", "b"],
      ],
      checks: [],
    },
  ],
  [
    "a string native enum",
    (z) => z.enum(Color),
    {
      kind: "enum",
      entries: [
        ["Red", "red"],
        ["Green", "green"],
      ],
      checks: [],
    },
  ],
  [
    "a numeric native enum — its reverse mappings dropped",
    (z) => z.enum(Level),
    {
      kind: "enum",
      entries: [
        ["Low", 1],
        ["High", 2],
      ],
      checks: [],
    },
  ],
  [
    "a strip object",
    (z) => z.object({ a: z.string(), b: z.number().optional() }),
    {
      kind: "object",
      shape: [
        ["a", str()],
        ["b", { kind: "optional", inner: num(), checks: [] }],
      ],
      unknownKeys: "strip",
      checks: [],
    },
  ],
  [
    "a strict object",
    (z) => z.object({}).strict(),
    { kind: "object", shape: [], unknownKeys: "strict", checks: [] },
  ],
  [
    "a passthrough object is opaque",
    (z) => z.object({}).passthrough(),
    { kind: "object", shape: [], unknownKeys: "opaque", checks: [] },
  ],
  [
    "an unknown catchall is opaque",
    (z) => z.object({}).catchall(z.unknown()),
    { kind: "object", shape: [], unknownKeys: "opaque", checks: [] },
  ],
  [
    "a schema catchall",
    (z) => z.object({}).catchall(z.number()),
    { kind: "object", shape: [], unknownKeys: { catchall: num() }, checks: [] },
  ],
  [
    "an array with bounds",
    (z) => z.array(z.string()).min(1).max(3),
    { kind: "array", element: str(), checks: [size("min", 1), size("max", 3)] },
  ],
  [
    "a nonempty array",
    (z) => z.array(z.string()).nonempty(),
    { kind: "array", element: str(), checks: [size("min", 1)] },
  ],
  [
    "a set's size is min + max",
    (z) => z.set(z.string()).size(2),
    { kind: "set", element: str(), checks: [size("min", 2), size("max", 2)] },
  ],
  [
    "a record",
    (z) => z.record(z.string(), z.number()),
    {
      kind: "record",
      key: str(),
      value: num(),
      mode: "strict",
      partial: false,
      checks: [],
    },
  ],
  [
    "a map",
    (z) => z.map(z.string(), z.number()),
    { kind: "map", key: str(), value: num(), checks: [] },
  ],
  [
    "a tuple with rest",
    (z) => z.tuple([z.string()]).rest(z.number()),
    { kind: "tuple", items: [str()], rest: num(), checks: [] },
  ],
  [
    "a fixed tuple",
    (z) => z.tuple([z.string(), z.number()]),
    { kind: "tuple", items: [str(), num()], rest: null, checks: [] },
  ],
  [
    "a union",
    (z) => z.union([z.string(), z.number()]),
    {
      kind: "union",
      options: [str(), num()],
      discriminator: null,
      inclusive: true,
      unionFallback: false,
      checks: [],
    },
  ],
  [
    "a discriminated union",
    (z) =>
      z.discriminatedUnion("t", [
        z.object({ t: z.literal("a") }),
        z.object({ t: z.literal("b") }),
      ]),
    {
      kind: "union",
      options: ["a", "b"].map((t) => ({
        kind: "object",
        shape: [["t", { kind: "literal", values: [t], checks: [] }]],
        unknownKeys: "strip",
        checks: [],
      })),
      discriminator: "t",
      inclusive: false,
      unionFallback: false,
      checks: [],
    },
  ],
  [
    "an intersection",
    (z) => z.intersection(z.string(), z.string()),
    { kind: "intersection", left: str(), right: str(), checks: [] },
  ],
  [
    "a refine is a check on the refined schema",
    (z) => z.string().refine((s) => s.length > 0),
    str([REFINE]),
  ],
  [
    "a superRefine on an object",
    (z) => z.object({}).superRefine(() => undefined),
    { kind: "object", shape: [], unknownKeys: "strip", checks: [REFINE] },
  ],
  [
    "a refine on a wrapper",
    (z) =>
      z
        .string()
        .optional()
        .refine(() => true),
    { kind: "optional", inner: str(), checks: [REFINE] },
  ],
  ["a brand is transparent", (z) => z.string().brand<"Id">(), str()],
  [
    "a transform is pipe(inner, transform)",
    (z) => z.string().transform((s) => s.length),
    {
      kind: "pipe",
      in: str(),
      out: { kind: "transform", fn: opaque("a transform"), checks: [] },
      checks: [],
    },
  ],
  [
    "a preprocess is pipe(transform, inner)",
    (z) => z.preprocess((v) => v, z.string()),
    {
      kind: "pipe",
      in: { kind: "transform", fn: opaque("a transform"), checks: [] },
      out: str(),
      checks: [],
    },
  ],
  [
    ".pipe() is pipe(in, out)",
    (z) => z.string().pipe(z.string().min(1)),
    { kind: "pipe", in: str(), out: str([size("min", 1)]), checks: [] },
  ],
  [
    "optional / nullable / readonly",
    (z) => z.string().nullable().optional().readonly(),
    {
      kind: "readonly",
      inner: {
        kind: "optional",
        inner: { kind: "nullable", inner: str(), checks: [] },
        checks: [],
      },
      checks: [],
    },
  ],
  [
    "a default",
    (z) => z.string().default("x"),
    { kind: "default", inner: str(), value: "x", checks: [] },
  ],
  [
    "a computed default is opaque",
    (z) => z.date().default(() => new Date()),
    {
      kind: "default",
      inner: { kind: "date", coerce: false, checks: [] },
      value: opaque("a default that is not one JSON value"),
      checks: [],
    },
  ],
  [
    "a catch",
    (z) => z.string().catch("x"),
    {
      kind: "catch",
      inner: str(),
      value: opaque("a catch value (a function of the failed input)"),
      checks: [],
    },
  ],
  [
    "a promise",
    (z) => z.promise(z.string()),
    { kind: "promise", inner: str(), checks: [] },
  ],
  [
    "a lazy",
    (z) => z.lazy(() => z.string()),
    { kind: "lazy", inner: str(), checks: [] },
  ],
  [
    "a custom is any + refine",
    (z) => z.custom<string>((v) => typeof v === "string"),
    { kind: "any", checks: [REFINE] },
  ],
];

describe("inspect", () => {
  test.each(CASES)("%s", (_name, build, expected) => {
    expect(describeSchema(build(z)).description).toEqual(expected);
  });

  test("a recursive lazy is cut", () => {
    type Tree = { children: Tree[] };
    const Tree: z.ZodType<Tree> = z.lazy(() =>
      z.object({ children: z.array(Tree) }),
    );
    const d = describeSchema(Tree).description as {
      inner: { shape: [string, { element: unknown }][] };
    };
    expect(d.inner.shape[0]![1].element).toEqual({ recursive: "lazy" });
  });

  test("the opaque parts are listed by path", () => {
    const s = z.object({
      a: z.array(z.string().transform((v) => v)),
      b: z.string().trim(),
    });
    expect(describeSchema(s).opaque).toEqual([
      "/a/[]/out: a transform",
      "/b: a rewrite check",
    ]);
  });

  test("a string's and an array's cap", () => {
    const s = inspect(z.string().max(9).length(4)) as SchemaNodeOf<"string">;
    expect(s.max).toBe(4);
    expect((inspect(z.string()) as SchemaNodeOf<"string">).max).toBeUndefined();
    const a = inspect(z.array(z.string()).max(7)) as SchemaNodeOf<"array">;
    expect(a.max).toBe(7);
    const set = inspect(z.set(z.string()).max(2)) as SchemaNodeOf<"set">;
    expect(set.max).toBe(2);
  });

  test("node.schema is the schema inspected, children are its own schemas", () => {
    const a = z.string();
    const o = z.object({ a });
    const node = inspect(o);
    expect(node.schema).toBe(o);
    expect(childrenOf(node)).toEqual([
      { edge: { kind: "key", key: "a" }, schema: a },
    ]);
    const branded = a.brand<"X">();
    expect(inspect(branded).schema).toBe(branded);
  });

  test("childrenOf every kind with children", () => {
    const kinds = (n: SchemaNode) => childrenOf(n).map((c) => c.edge.kind);
    expect(
      kinds(inspect(z.object({ a: z.string() }).catchall(z.number()))),
    ).toEqual(["key", "catchall"]);
    expect(kinds(inspect(z.record(z.string(), z.number())))).toEqual([
      "keyType",
      "valueType",
    ]);
    expect(kinds(inspect(z.tuple([z.string()]).rest(z.number())))).toEqual([
      "item",
      "rest",
    ]);
    expect(kinds(inspect(z.string().transform((s) => s)))).toEqual([
      "in",
      "out",
    ]);
    expect(kinds(inspect(z.string().optional()))).toEqual(["inner"]);
    expect(kinds(inspect(z.string()))).toEqual([]);
  });

  test("peel strips the value-keeping wrappers, outermost first", () => {
    const inner = z.string().min(1);
    const { node, peeled } = peel(
      inner.nullable().optional().default("a").catch("b").readonly(),
    );
    expect(node.schema).toBe(inner);
    expect(peeled).toEqual([
      "readonly",
      "catch",
      "default",
      "optional",
      "nullable",
    ]);
    expect(peel(z.string()).peeled).toEqual([]);
    expect(peel(z.string().transform((s) => s)).node.kind).toBe("pipe");
  });

  test("valueSide: in for a transform, out for a pipe and a preprocess", () => {
    const s = z.string().min(2);
    const side = (x: unknown) => valueSide(inspect(x) as SchemaNodeOf<"pipe">);
    expect(side(s.transform((v) => v.length))).toBe(s);
    expect(side(z.preprocess((v) => v, s))).toBe(s);
    const out = z.string().max(3);
    expect(side(s.pipe(out))).toBe(out);
  });

  test("isUncheckedBase: a bare base, no check of any kind", () => {
    expect(isUncheckedBase(z.string())).toBe(true);
    expect(isUncheckedBase(z.string().brand<"X">())).toBe(true);
    expect(isUncheckedBase(z.number())).toBe(true);
    expect(isUncheckedBase(z.boolean())).toBe(true);
    expect(isUncheckedBase(z.unknown())).toBe(true);
    expect(isUncheckedBase(z.string().min(1))).toBe(false);
    expect(isUncheckedBase(z.string().email())).toBe(false);
    expect(isUncheckedBase(z.string().refine(() => true))).toBe(false);
    expect(isUncheckedBase(z.string().trim())).toBe(false);
    expect(isUncheckedBase(z.coerce.string())).toBe(false);
    expect(isUncheckedBase(z.string().optional())).toBe(false);
    expect(isUncheckedBase(z.enum(["a"]))).toBe(false);
    expect(isUncheckedBase(z.literal("a"))).toBe(false);
  });

  test("a default node's value is a fresh fill per call", () => {
    let n = 0;
    const node = inspect(
      z.number().default(() => ++n),
    ) as SchemaNodeOf<"default">;
    expect(node.defaultValue()).toBe(1);
    expect(node.defaultValue()).toBe(2);
  });
});

describe("inspect — zod 4 forms", () => {
  test("a format schema reads its own format as a check", () => {
    expect(describeSchema(z.email()).description).toEqual(str([fmt("email")]));
    expect(describeSchema(z.int()).description).toEqual(
      num([{ kind: "numberFormat", format: "safeint" }]),
    );
  });

  test("prefault, nonoptional, success", () => {
    expect(describeSchema(z.string().prefault("a")).description).toEqual({
      kind: "prefault",
      inner: str(),
      value: "a",
      checks: [],
    });
    expect(inspect(z.string().optional().nonoptional()).kind).toBe(
      "nonoptional",
    );
    expect(inspect(z.success(z.string())).kind).toBe("success");
    expect(peel(z.string().prefault("a")).peeled).toEqual(["prefault"]);
  });

  test("an overwrite is a rewrite check; a lowercase format is a test", () => {
    expect(inspect(z.string().overwrite((s) => s)).checks).toEqual([
      { kind: "rewrite" },
    ]);
    expect(inspect(z.string().lowercase()).checks).toEqual([fmt("lowercase")]);
  });

  test(".check(fn) is a refine", () => {
    expect(inspect(z.string().check(() => undefined)).checks).toEqual([
      { kind: "refine" },
    ]);
  });

  test("z.looseObject / z.strictObject", () => {
    const keys = (s: unknown) =>
      (inspect(s) as SchemaNodeOf<"object">).unknownKeys;
    expect(keys(z.looseObject({}))).toBe("opaque");
    expect(keys(z.strictObject({}))).toBe("strict");
  });

  test("a file, a template literal", () => {
    expect(
      describeSchema(z.file().max(10).mime(["image/png"])).description,
    ).toEqual({
      kind: "file",
      checks: [size("max", 10), { kind: "mimeType", mime: ["image/png"] }],
    });
    expect(inspect(z.templateLiteral(["a", z.string()])).kind).toBe(
      "template_literal",
    );
  });
});

describe("describeSchema — what moves the description", () => {
  const same = (a: unknown, b: unknown) =>
    JSON.stringify(describeSchema(a).description) ===
    JSON.stringify(describeSchema(b).description);
  const keys = z.enum(["a", "b"]);

  test("a record's mode and partiality", () => {
    expect(
      same(z.record(keys, z.string()), z.partialRecord(keys, z.string())),
    ).toBe(false);
    expect(
      same(z.record(keys, z.string()), z.looseRecord(keys, z.string())),
    ).toBe(false);
  });

  test("a union's inclusiveness", () => {
    expect(
      same(z.union([z.string(), z.number()]), z.xor([z.string(), z.number()])),
    ).toBe(false);
  });

  test("a template literal's parts", () => {
    expect(
      same(
        z.templateLiteral(["user-", z.number()]),
        z.templateLiteral(["task-", z.number()]),
      ),
    ).toBe(false);
    expect(
      same(
        z.templateLiteral(["user-", z.number()]),
        z.templateLiteral(["user-", z.string()]),
      ),
    ).toBe(false);
  });

  test("a function's signature", () => {
    expect(
      same(
        z.function({ input: [z.string()], output: z.number() }),
        z.function({ input: [z.number()], output: z.number() }),
      ),
    ).toBe(false);
  });

  test("a url's normalize and a format's own pattern", () => {
    expect(same(z.url(), z.url({ normalize: true }))).toBe(false);
    expect(same(z.email(), z.email({ pattern: /^a@b$/ }))).toBe(false);
    expect(same(z.stringFormat("f", /^a$/), z.stringFormat("f", /^b$/))).toBe(
      false,
    );
  });

  test("a custom format's function is a refine check beside it", () => {
    expect(inspect(z.stringFormat("f", (s) => s.length > 1)).checks).toEqual([
      { kind: "format", format: "f", params: {}, rewrites: false },
      { kind: "refine" },
    ]);
  });

  test("a codec is blinded: its decode is a function body", () => {
    const codec = z.codec(z.string(), z.string(), {
      decode: (s) => s.toUpperCase(),
      encode: (s) => s,
    });
    expect(describeSchema(codec).opaque).toEqual(["(root): a codec transform"]);
    expect(describeSchema(z.stringbool()).opaque).toEqual([
      "(root): a codec transform",
    ]);
    expect(describeSchema(z.string().pipe(z.string())).opaque).toEqual([]);
  });
});

describe("inspect — not a schema", () => {
  test("throws loudly", () => {
    expect(() => inspect({})).toThrow(/not a zod 4 schema/);
    expect(() => inspect(null)).toThrow(/not a zod 4 schema/);
    expect(() => inspect("z.string()")).toThrow(/not a zod 4 schema/);
  });

  test("a zod 3 schema is named", () => {
    const v3 = { _def: { typeName: "ZodString", checks: [] } };
    expect(() => inspect(v3)).toThrow(/a zod 3 schema/);
  });

  test("isZodSchema", () => {
    expect(isZodSchema(z.string())).toBe(true);
    expect(isZodSchema({ _def: { typeName: "ZodString" } })).toBe(false);
    expect(isZodSchema(undefined)).toBe(false);
  });
});
