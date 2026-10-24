/**
 * `describeZodParts` (A18): a zod schema as data, FAIL-CLOSED — every part
 * whose output depends on a function body is marked opaque and listed, so a
 * persisted compile's definition never treats a body it cannot see as data.
 *
 * Run: `./equin test plugins/infra/plugins/query-resource`.
 */

import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { describeZod, describeZodParts } from "./fingerprint";

const opaqueOf = (s: unknown): readonly string[] => describeZodParts(s).opaque;
const same = (a: unknown, b: unknown): boolean =>
  JSON.stringify(describeZod(a)) === JSON.stringify(describeZod(b));

describe("describeZodParts", () => {
  test("data-only schemas have no opaque part", () => {
    for (const s of [
      z.string().min(1).regex(/a/i),
      z.object({ a: z.number().int(), b: z.boolean().nullable() }).strict(),
      z.array(z.enum(["x", "y"])).max(3),
      z.union([z.literal("a"), z.null()]),
      z.discriminatedUnion("k", [
        z.object({ k: z.literal("a") }),
        z.object({ k: z.literal("b"), v: z.date() }),
      ]),
      z.tuple([z.string()]).rest(z.number()),
      z.record(z.string(), z.unknown()),
      z.set(z.string()).min(1),
      z.map(z.string(), z.bigint()),
      z.intersection(z.object({ a: z.string() }), z.object({ b: z.string() })),
      z.string().pipe(z.string().max(2)),
      z.string().brand("B").readonly(),
      z.string().default("d"),
      z.object({ a: z.string() }).default({ a: "x" }),
      // A refinement accepts or refuses a value; it never changes one.
      z.string().refine((s) => s.length > 0),
      z.number().superRefine(() => undefined),
    ]) {
      expect(opaqueOf(s)).toEqual([]);
    }
  });

  test("a transform, preprocess, catch, computed default or unknown type is opaque, by path", () => {
    expect(
      opaqueOf(z.object({ a: z.array(z.string().transform((s) => s)) })),
    ).toEqual(["/a/[]: a transform effect"]);
    expect(opaqueOf(z.preprocess((v) => v, z.string()))).toEqual([
      "(root): a preprocess effect",
    ]);
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
    expect(opaqueOf(z.promise(z.string()))).toEqual([
      "(root): an unhandled ZodPromise",
    ]);
    expect(opaqueOf({ notZod: true })).toEqual([
      "(root): a object, not a zod schema",
    ]);
    // The marker is in the description too, so it differs from the plain schema.
    expect(
      same(
        z.string().transform((s) => s),
        z.string(),
      ),
    ).toBe(false);
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

  test("a recursive lazy schema terminates", () => {
    interface Node {
      children: Node[];
    }
    const node: z.ZodType<Node> = z.lazy(() =>
      z.object({ children: z.array(node) }),
    );
    expect(opaqueOf(node)).toEqual([]);
    expect(JSON.stringify(describeZod(node))).toContain("recursive");
  });
});
