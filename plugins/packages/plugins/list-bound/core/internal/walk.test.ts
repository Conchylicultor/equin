import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  cappedList,
  cappedRecord,
  wholeKeyedRecord,
  wholeList,
  wholeRecord,
  wholeTuple,
} from "./markers";
import {
  BareListError,
  LIST_ROOT_PATH,
  listBoundsOf,
  listShapeOf,
} from "./walk";

const Item = z.object({ id: z.string(), n: z.number() });

describe("markers — the parse", () => {
  test("a whole list and a whole record parse exactly as their bare forms", () => {
    const value = [{ id: "a", n: 1 }];
    expect(wholeList(Item, { reason: "r" }).parse(value)).toEqual(value);
    expect(wholeRecord(z.number(), { reason: "r" }).parse({ a: 1 })).toEqual({
      a: 1,
    });
    expect(
      wholeList(Item, { reason: "r" }).safeParse([{ id: 1 }]).success,
    ).toBe(false);
  });

  test("a capped list refuses one item past its cap", () => {
    const s = cappedList(z.number(), { max: 2 });
    expect(s.parse([1, 2])).toEqual([1, 2]);
    expect(s.safeParse([1, 2, 3]).success).toBe(false);
  });

  test("a capped record refuses one entry past its cap", () => {
    const s = cappedRecord(z.number(), { max: 2 });
    expect(s.parse({ a: 1, b: 2 })).toEqual({ a: 1, b: 2 });
    const r = s.safeParse({ a: 1, b: 2, c: 3 });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0]!.message).toContain("capped at 2");
  });

  test("a malformed marker throws where it is declared", () => {
    expect(() => cappedList(Item, { max: 0 })).toThrow("positive integer");
    expect(() => cappedList(Item, { max: 1.5 })).toThrow("positive integer");
    expect(() => cappedRecord(Item, { max: -1 })).toThrow("positive integer");
    expect(() => wholeList(Item, { reason: "" })).toThrow("empty reason");
    expect(() => wholeRecord(Item, { reason: "  " })).toThrow("empty reason");
  });
});

describe("markers — the tag survives zod's clones", () => {
  const whole = wholeList(Item, { reason: "a handful" });

  test.each([
    ["optional", whole.optional()],
    ["nullable", whole.nullable()],
    ["describe", whole.describe("rows")],
    ["min", whole.min(1)],
    ["nonempty", whole.nonempty()],
    ["default", whole.default([])],
    ["readonly", whole.readonly()],
    [
      "optional().nullable().describe()",
      whole.optional().nullable().describe("x"),
    ],
  ] as const)("%s", (_, schema) => {
    expect(listShapeOf(schema).bounds).toEqual([
      { path: LIST_ROOT_PATH, reason: "a handful" },
    ]);
  });

  test(".max(n) on a whole list makes it capped — the cap is what the parse enforces", () => {
    expect(listShapeOf(whole.max(7)).bounds).toEqual([
      { path: LIST_ROOT_PATH, max: 7 },
    ]);
  });

  test("a capped record keeps its tag under .optional() / .describe()", () => {
    const s = cappedRecord(z.string(), { max: 9 }).optional().describe("x");
    expect(listShapeOf(s).bounds).toEqual([{ path: LIST_ROOT_PATH, max: 9 }]);
  });
});

describe("listShapeOf — the walk", () => {
  test("a schema with no list reports nothing", () => {
    expect(listShapeOf(Item)).toEqual({ bounds: [], bare: [] });
    expect(listShapeOf(z.string())).toEqual({ bounds: [], bare: [] });
  });

  test("a native .max(n) / .length(n) counts as capped", () => {
    expect(listShapeOf(z.array(Item).max(5)).bounds).toEqual([
      { path: LIST_ROOT_PATH, max: 5 },
    ]);
    expect(listShapeOf(z.array(Item).length(3)).bounds).toEqual([
      { path: LIST_ROOT_PATH, max: 3 },
    ]);
    expect(listShapeOf(z.set(z.string()).max(4)).bounds).toEqual([
      { path: LIST_ROOT_PATH, max: 4 },
    ]);
  });

  test("a bare list is reported by path, not refused", () => {
    expect(listShapeOf(z.array(Item))).toEqual({
      bounds: [],
      bare: [LIST_ROOT_PATH],
    });
  });

  test("nested lists are named by their path from the root", () => {
    const s = z.object({
      rows: cappedList(
        z.object({
          segments: z.array(z.string()),
          tags: wholeList(z.string(), { reason: "a row's own tags" }),
        }),
        { max: 500 },
      ),
      counts: z.record(z.number()),
      truncated: z.boolean(),
    });
    expect(listShapeOf(s)).toEqual({
      bounds: [
        { path: "rows", max: 500 },
        { path: "rows[].tags", reason: "a row's own tags" },
      ],
      bare: ["rows[].segments", "counts"],
    });
  });

  test("records, maps and sets, and the lists inside them", () => {
    const s = z.object({
      byId: wholeRecord(z.object({ parts: z.array(z.string()) }), {
        reason: "r",
      }),
      m: z.map(z.string(), z.array(z.number())),
      s: z.set(z.string()),
    });
    expect(listShapeOf(s)).toEqual({
      bounds: [{ path: "byId", reason: "r" }],
      bare: ["byId{}.parts", "m", "m{}", "s"],
    });
  });

  test("a record keyed by a finite set is capped by it", () => {
    const keys = z.enum(["a", "b", "c"]);
    expect(listShapeOf(z.record(keys, z.number())).bounds).toEqual([
      { path: LIST_ROOT_PATH, max: 3 },
    ]);
    const lits = z.union([z.literal("x"), z.literal("y")]);
    expect(listShapeOf(z.record(lits, z.number())).bounds).toEqual([
      { path: LIST_ROOT_PATH, max: 2 },
    ]);
    enum Num {
      A,
      B,
    }
    expect(listShapeOf(z.record(z.nativeEnum(Num), z.number())).bounds).toEqual(
      [{ path: LIST_ROOT_PATH, max: 2 }],
    );
  });

  test("unions and discriminated unions: every option's lists, deduped by path and bound", () => {
    const s = z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("a"), xs: z.array(z.string()) }),
      z.object({ kind: z.literal("b"), xs: z.array(z.string()) }),
      z.object({
        kind: z.literal("c"),
        ys: cappedList(z.string(), { max: 3 }),
      }),
    ]);
    expect(listShapeOf(s)).toEqual({
      bounds: [{ path: "ys", max: 3 }],
      bare: ["xs"],
    });
    expect(
      listShapeOf(z.union([z.array(z.string()), z.string()])).bare,
    ).toEqual([LIST_ROOT_PATH]);
  });

  test("intersections, tuples, effects, pipelines, branded, catch, promise", () => {
    const s = z.object({
      i: z.intersection(
        z.object({ a: z.array(z.string()) }),
        z.object({ b: z.array(z.number()).max(2) }),
      ),
      t: z.tuple([z.string(), z.array(z.string())]),
      rest: z.tuple([z.string()]).rest(z.number()),
      e: z.array(z.string()).transform((xs) => xs.length),
      r: z.array(z.string()).refine((xs) => xs.length > 0),
      p: z.string().pipe(z.array(z.string()).max(1)),
      br: z.array(z.string()).brand<"X">(),
      c: z.array(z.string()).catch([]),
      pr: z.promise(z.array(z.string())),
    });
    expect(listShapeOf(s)).toEqual({
      bounds: [
        { path: "i.b", max: 2 },
        { path: "p", max: 1 },
      ],
      bare: ["i.a", "t[1]", "rest", "e", "r", "br", "c", "pr"],
    });
  });

  test("a whole tuple's rest is a whole list, and parses as the tuple", () => {
    const s = wholeTuple([z.string(), z.string()], z.string(), {
      reason: "r",
    }).readonly();
    expect(listShapeOf(s)).toEqual({
      bounds: [{ path: LIST_ROOT_PATH, reason: "r" }],
      bare: [],
    });
    expect(s.parse(["a", "b", "c"])).toEqual(["a", "b", "c"]);
    expect(s.safeParse(["a"]).success).toBe(false);
  });

  test("a whole keyed record keeps its key schema", () => {
    const s = wholeKeyedRecord(z.string().regex(/^[a-z]+$/), z.number(), {
      reason: "r",
    });
    expect(listShapeOf(s)).toEqual({
      bounds: [{ path: LIST_ROOT_PATH, reason: "r" }],
      bare: [],
    });
    expect(s.safeParse({ ab: 1 }).success).toBe(true);
    expect(s.safeParse({ AB: 1 }).success).toBe(false);
  });

  test("an object catchall is a record", () => {
    const s = z.object({ a: z.string() }).catchall(z.array(z.number()));
    expect(listShapeOf(s).bare).toEqual([LIST_ROOT_PATH, "{}"]);
  });

  test("unknown and any are opaque", () => {
    expect(
      listShapeOf(z.object({ u: z.unknown(), a: z.any(), c: z.custom() })),
    ).toEqual({ bounds: [], bare: [] });
  });

  test("lazy recursion is cut, each list reported once", () => {
    interface Node {
      name: string;
      children: Node[];
    }
    const NodeSchema: z.ZodType<Node> = z.lazy(() =>
      z.object({
        name: z.string(),
        children: wholeList(NodeSchema, { reason: "a tree" }),
      }),
    );
    expect(listShapeOf(NodeSchema)).toEqual({
      bounds: [{ path: "children", reason: "a tree" }],
      bare: [],
    });
    const Bare: z.ZodType<Node> = z.lazy(() =>
      z.object({ name: z.string(), children: z.array(Bare) }),
    );
    expect(listShapeOf(z.object({ root: Bare })).bare).toEqual([
      "root.children",
    ]);
  });

  test("a schema shared by two fields is reported under each", () => {
    const Shared = z.object({ xs: z.array(z.string()) });
    expect(listShapeOf(z.object({ a: Shared, b: Shared })).bare).toEqual([
      "a.xs",
      "b.xs",
    ]);
  });

  test("a recursion cut below a shared node does not hide its lists elsewhere", () => {
    // B is reached first under A (where its link back to A is cut), then
    // from the root on its own: there its walk must reach A's lists again.
    const A: z.ZodTypeAny = z.lazy(() =>
      z.object({ b: B, as: z.array(z.string()) }),
    );
    const B: z.ZodTypeAny = z.lazy(() => z.object({ a: A.optional() }));
    expect(listShapeOf(z.object({ x: A, y: B })).bare).toEqual([
      "x.as",
      "y.a.as",
    ]);
  });

  test("`at` prefixes every path (a page's item)", () => {
    const item = z.object({ segments: z.array(z.string()) });
    expect(listShapeOf(item, { at: "[]" }).bare).toEqual(["[].segments"]);
  });

  test("a malformed tag set by hand throws, naming the path", () => {
    const s = z.array(z.string());
    (s._def as unknown as Record<string, unknown>).listBound = { reason: "" };
    expect(() => listShapeOf(z.object({ xs: s }))).toThrow("`xs`");
    const t = z.array(z.string());
    (t._def as unknown as Record<string, unknown>).listBound = { size: 3 };
    expect(() => listShapeOf(t)).toThrow("malformed tag");
  });

  test("a value that is not a zod 3 schema throws", () => {
    expect(() => listShapeOf({})).toThrow("not a zod 3 schema");
    expect(() => listShapeOf(null)).toThrow("not a zod 3 schema");
  });
});

describe("listBoundsOf — enforcing", () => {
  test("returns the bounds of a fully bounded schema", () => {
    expect(
      listBoundsOf(z.object({ xs: cappedList(z.string(), { max: 3 }) })),
    ).toEqual([{ path: "xs", max: 3 }]);
  });

  test("throws a BareListError naming every bare list", () => {
    const s = z.object({ a: z.array(z.string()), b: z.record(z.number()) });
    let thrown: unknown;
    try {
      listBoundsOf(s, { where: 'liveValue("k")' });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(BareListError);
    expect((thrown as BareListError).paths).toEqual(["a", "b"]);
    expect((thrown as BareListError).message).toContain('liveValue("k")');
  });
});
