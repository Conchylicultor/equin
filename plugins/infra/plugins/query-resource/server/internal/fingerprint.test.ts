/**
 * `describeZod` (A18): a zod schema as data, FAIL-CLOSED — every part whose
 * output depends on a function body is marked opaque and listed, so a
 * persisted compile's definition never treats a body it cannot see as data —
 * built from the repo-owned SchemaNode, so a zod upgrade cannot move a
 * definition.
 *
 * Run: `./equin test plugins/infra/plugins/query-resource`.
 */

import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { describeSchema } from "@plugins/packages/plugins/zod-introspect/core";
import { describeZod } from "./fingerprint";

const opaqueOf = (s: unknown): readonly string[] => describeSchema(s).opaque;
const json = (s: unknown): string => JSON.stringify(describeZod(s));
const same = (a: unknown, b: unknown): boolean => json(a) === json(b);

type Z = typeof z;

/** Data-only schemas. */
const DATA_ONLY: readonly (readonly [string, (z: Z) => unknown])[] = [
  ["a checked string", (z) => z.string().min(1).regex(/a/i)],
  [
    "a strict object",
    (z) =>
      z.object({ a: z.number().int(), b: z.boolean().nullable() }).strict(),
  ],
  ["a capped enum array", (z) => z.array(z.enum(["x", "y"])).max(3)],
  ["a union", (z) => z.union([z.literal("a"), z.null()])],
  [
    "a discriminated union",
    (z) =>
      z.discriminatedUnion("k", [
        z.object({ k: z.literal("a") }),
        z.object({ k: z.literal("b"), v: z.date() }),
      ]),
  ],
  ["a tuple with a rest", (z) => z.tuple([z.string()]).rest(z.number())],
  ["a record", (z) => z.record(z.string(), z.unknown())],
  ["a bounded set", (z) => z.set(z.string()).min(1)],
  ["a map", (z) => z.map(z.string(), z.bigint())],
  [
    "an intersection",
    (z) =>
      z.intersection(z.object({ a: z.string() }), z.object({ b: z.string() })),
  ],
  ["a pipe", (z) => z.string().pipe(z.string().max(2))],
  ["a branded readonly", (z) => z.string().brand("B").readonly()],
  ["a literal default", (z) => z.string().default("d")],
  ["an object default", (z) => z.object({ a: z.string() }).default({ a: "x" })],
  ["a passthrough object", (z) => z.object({ a: z.string() }).passthrough()],
  ["a catchall", (z) => z.object({ a: z.string() }).catchall(z.number())],
  ["a coerced number", (z) => z.coerce.number().positive()],
  ["a formatted string", (z) => z.string().email().max(80)],
  ["a promise", (z) => z.promise(z.string())],
  // A refinement accepts or refuses a value; it never changes one.
  ["a refinement", (z) => z.string().refine((s) => s.length > 0)],
  ["a super-refinement", (z) => z.number().superRefine(() => undefined)],
];

describe("describeZod", () => {
  test.each(DATA_ONLY)("%s has no opaque part", (_name, build) => {
    expect(opaqueOf(build(z))).toEqual([]);
  });

  test("a recursive lazy schema terminates", () => {
    interface Node {
      children: Node[];
    }
    const tree = (z: Z): unknown => {
      const node: z.ZodType<Node> = z.lazy(() =>
        z.object({ children: z.array(node) }),
      );
      return node;
    };
    expect(opaqueOf(tree(z))).toEqual([]);
    expect(json(tree(z))).toContain("recursive");
  });

  // The description itself is part of every persisted compile's definition:
  // pinned, so a change to it is a reviewed move of every L2 snapshot.
  test("the description is pinned", () => {
    expect(
      describeZod(
        z.object({
          id: z.string().min(1),
          n: z.number().int().nullable(),
          tags: z.array(z.enum(["a", "b"])).max(2),
        }),
      ),
    ).toEqual({
      kind: "object",
      shape: [
        [
          "id",
          {
            kind: "string",
            coerce: false,
            checks: [{ kind: "size", bound: "min", value: 1 }],
          },
        ],
        [
          "n",
          {
            kind: "nullable",
            inner: {
              kind: "number",
              coerce: false,
              checks: [{ kind: "numberFormat", format: "safeint" }],
            },
            checks: [],
          },
        ],
        [
          "tags",
          {
            kind: "array",
            element: {
              kind: "enum",
              entries: [
                ["a", "a"],
                ["b", "b"],
              ],
              checks: [],
            },
            checks: [{ kind: "size", bound: "max", value: 2 }],
          },
        ],
      ],
      unknownKeys: "strip",
      checks: [],
    });
  });
});

describe("describeZod's opaque parts", () => {
  test("a transform, preprocess, rewrite, catch or computed default is opaque, by path", () => {
    expect(
      opaqueOf(z.object({ a: z.array(z.string().transform((s) => s)) })),
    ).toEqual(["/a/[]/out: a transform"]);
    expect(opaqueOf(z.preprocess((v) => v, z.string()))).toEqual([
      "/in: a transform",
    ]);
    expect(opaqueOf(z.string().trim())).toEqual(["(root): a rewrite check"]);
    expect(opaqueOf(z.string().catch("x"))).toEqual([
      "(root): a catch value (a function of the failed input)",
    ]);
    let n = 0;
    expect(opaqueOf(z.number().default(() => n++))).toEqual([
      "(root): a default that is not one JSON value",
    ]);
    expect(opaqueOf(z.date().default(() => new Date(0)))).toEqual([
      "(root): a default that is not one JSON value",
    ]);
    // The marker is in the description too, so it differs from the plain schema.
    expect(
      same(
        z.string().transform((s) => s),
        z.string(),
      ),
    ).toBe(false);
  });

  test("a value that is not a zod schema throws", () => {
    expect(() => describeZod({ notZod: true })).toThrow(TypeError);
  });

  test("a literal default's value, a catchall, a regex's flags and a length are part of it", () => {
    expect(same(z.string().default("a"), z.string().default("b"))).toBe(false);
    expect(same(z.string().default("a"), z.string().default("a"))).toBe(true);
    expect(
      same(
        z.object({ a: z.string() }).catchall(z.number()),
        z.object({ a: z.string() }),
      ),
    ).toBe(false);
    expect(same(z.string().regex(/a/i), z.string().regex(/a/))).toBe(false);
    expect(same(z.array(z.string()).max(2), z.array(z.string()))).toBe(false);
    expect(
      same(
        z.intersection(z.string(), z.string().min(1)),
        z.intersection(z.string(), z.string()),
      ),
    ).toBe(false);
  });
});
