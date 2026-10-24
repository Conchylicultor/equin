import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { resourceDescriptorByKey } from "@plugins/primitives/plugins/live-state/core";
import {
  ResourceContractError,
  ResourceRefusal,
} from "@plugins/packages/plugins/resource-protocol/core";
import {
  wholeList,
  wholeRecord,
} from "@plugins/packages/plugins/list-bound/core";
import { liveValue } from "./live-value";

const S = z.object({ n: z.number() });

describe("liveValue", () => {
  test("a param-less, un-preloaded value: no preload, no defaultParams", () => {
    const v = liveValue("test.live-value.plain", { schema: S });
    expect(v.live).toBe("value");
    expect(v.params).toEqual([]);
    expect(v.preload).toBeUndefined();
    expect(v.defaultParams).toBeUndefined();
    expect(v.keyed).toBeUndefined();
    // Registered, so boot hydration can resolve its key.
    expect(resourceDescriptorByKey("test.live-value.plain")).toBe(v);
  });

  test('"none" is the absence of a preload', () => {
    const v = liveValue("test.live-value.none", { schema: S, preload: "none" });
    expect(v.preload).toBeUndefined();
    expect(v.defaultParams).toBeUndefined();
  });

  test("a preloaded value carries the flag and the {} default tuple", () => {
    const boot = liveValue("test.live-value.boot", {
      schema: S,
      preload: "boot",
    });
    expect(boot.preload).toBe("boot");
    expect(boot.defaultParams).toEqual({});
    const keep = liveValue("test.live-value.keep", {
      schema: S,
      preload: "boot-and-keep",
    });
    expect(keep.preload).toBe("boot-and-keep");
    expect(keep.defaultParams).toEqual({});
  });

  test("params derive P and are recorded; a parameterized value has no default tuple", () => {
    const v = liveValue("test.live-value.params", {
      schema: S,
      params: ["id", "scope"],
    });
    expect(v.params).toEqual(["id", "scope"]);
    expect(v.defaultParams).toBeUndefined();
    const p: NonNullable<typeof v.__params> = { id: "a", scope: "b" };
    expect(p.id).toBe("a");
    // @ts-expect-error — `P` has exactly the declared names
    const bad: NonNullable<typeof v.__params> = { id: "a" };
    expect(bad).toBeDefined();
  });

  test('a trailing "?" declares an optional param: P marks it optional, the descriptor lists it', () => {
    const v = liveValue("test.live-value.optional", {
      schema: S,
      params: ["path", "scopeId?"],
    });
    expect(v.params).toEqual(["path", "scopeId"]);
    expect(v.optionalParams).toEqual(["scopeId"]);
    const base: NonNullable<typeof v.__params> = { path: "a" };
    const scoped: NonNullable<typeof v.__params> = { path: "a", scopeId: "s" };
    expect([base, scoped]).toHaveLength(2);
    // @ts-expect-error — the required name stays required
    const bad: NonNullable<typeof v.__params> = { scopeId: "s" };
    expect(bad).toBeDefined();
    // A value with no optional name carries no list.
    expect(
      liveValue("test.live-value.required-only", { schema: S, params: ["id"] })
        .optionalParams,
    ).toBeUndefined();
  });

  test("a bad param name throws (empty, inner ?, duplicate)", () => {
    for (const params of [["?"], ["a?b"], ["id", "id?"]] as const) {
      expect(() =>
        liveValue(`test.live-value.bad-${params.join("-")}`, {
          schema: S,
          params: params as unknown as readonly [string, ...string[]],
        }),
      ).toThrow(/bad param name/);
    }
  });

  test("a parameterized value may be preloaded: no default tuple, and it is branded preloadsParams", () => {
    const v = liveValue("test.live-value.param-preload", {
      schema: S,
      params: ["path", "scopeId?"],
      preload: "boot-and-keep",
    });
    expect(v.preload).toBe("boot-and-keep");
    expect(v.preloadsParams).toBe(true);
    expect(v.defaultParams).toBeUndefined();
    // A param-less preload is not branded (it has its `{}` default tuple).
    expect(
      "preloadsParams" in
        liveValue("test.live-value.boot-unbranded", {
          schema: S,
          preload: "boot",
        }),
    ).toBe(false);
  });

  test("a central value cannot be preloaded", () => {
    expect(() =>
      liveValue("test.live-value.central-preload", {
        schema: S,
        origin: "central",
        // `preload` is `never` on a central value (tsc) — an untyped caller here.
        preload: "boot" as never,
      }),
    ).toThrow(/central value cannot be preloaded/);
  });

  describe("validateParams — the runtime's params gate", () => {
    const v = liveValue("test.live-value.gate", {
      schema: S,
      params: ["id", "scope"],
    });
    const plain = liveValue("test.live-value.gate-plain", { schema: S });

    test("accepts exactly the declared names", () => {
      expect(() => v.validateParams({ id: "a", scope: "b" })).not.toThrow();
      expect(() => plain.validateParams({})).not.toThrow();
    });

    test("refuses a missing, an unknown or a non-string param — typed", () => {
      const bad: Record<string, unknown>[] = [
        { id: "a" },
        { id: "a", scope: "b", extra: "c" },
        { id: "a", scope: 1 },
      ];
      for (const params of bad) {
        expect(() =>
          v.validateParams(params as Record<string, string>),
        ).toThrow(ResourceContractError);
      }
      expect(() => plain.validateParams({ limit: "5" })).toThrow(
        /unknown param "limit"/,
      );
    });

    test("an optional param may be absent; a required one may not; unknown still refused", () => {
      const o = liveValue("test.live-value.gate-optional", {
        schema: S,
        params: ["path", "scopeId?"],
      });
      expect(() => o.validateParams({ path: "a" })).not.toThrow();
      expect(() => o.validateParams({ path: "a", scopeId: "s" })).not.toThrow();
      expect(() => o.validateParams({ scopeId: "s" })).toThrow(
        /missing param "path"/,
      );
      expect(() => o.validateParams({ path: "a", other: "x" })).toThrow(
        /unknown param "other"/,
      );
    });
  });

  describe("typed params — a record of string parsers", () => {
    const WINDOWS = ["1h", "24h", "7d"] as const;
    const v = liveValue("test.live-value.typed", {
      schema: S,
      params: { window: z.enum(WINDOWS), id: z.string().min(1) },
    });

    test("records the names (all required) and derives P from each parser's output", () => {
      expect(v.params).toEqual(["window", "id"]);
      expect(v.optionalParams).toBeUndefined();
      const p: NonNullable<typeof v.__params> = { window: "24h", id: "x" };
      expect(p.window).toBe("24h");
      type P = NonNullable<typeof v.__params>;
      // @ts-expect-error — "2h" is not one of the parser's outputs
      const badWindow: P["window"] = "2h";
      // @ts-expect-error — every typed param is required
      const missing: NonNullable<typeof v.__params> = { window: "1h" };
      expect([badWindow, missing]).toHaveLength(2);
    });

    test("the gate accepts a tuple every parser admits", () => {
      expect(() => v.validateParams({ window: "7d", id: "a" })).not.toThrow();
    });

    test("the gate refuses a value a parser refuses, a missing, an unknown or a non-string param — typed", () => {
      const bad: Record<string, unknown>[] = [
        { window: "2h", id: "a" },
        { window: "1h", id: "" },
        { window: "1h" },
        { window: "1h", id: "a", extra: "x" },
        { window: 1, id: "a" },
      ];
      for (const params of bad) {
        expect(() =>
          v.validateParams(params as Record<string, string>),
        ).toThrow(ResourceContractError);
      }
      expect(() => v.validateParams({ window: "2h", id: "a" })).toThrow(
        /param "window" = "2h" is refused/,
      );
    });

    test("a transforming, refining, defaulting or catching parser throws at declaration — wherever it hides", () => {
      const refused: [string, z.ZodType<string, z.ZodTypeDef, unknown>][] = [
        ["ZodEffects", z.string().transform((s) => s.toLowerCase())],
        ["ZodEffects", z.string().refine((s) => s.length > 0)],
        ["ZodEffects", z.preprocess((x) => String(x), z.string())],
        ["ZodDefault", z.string().default("1h")],
        ["ZodCatch", z.string().catch("1h")],
        ["ZodEffects", z.string().pipe(z.string().transform((s) => s.trim()))],
        ["ZodDefault", z.union([z.literal("a"), z.string().default("b")])],
        // String checks that rewrite the value in place (no ZodEffects).
        ["ZodString \\.trim\\(\\)", z.string().trim()],
        ["ZodString \\.toLowerCase\\(\\)", z.string().min(1).toLowerCase()],
        [
          "ZodString \\.toUpperCase\\(\\)",
          z.string().pipe(z.string().toUpperCase()),
        ],
      ];
      refused.forEach(([kind, parser], i) => {
        expect(() =>
          liveValue(`test.live-value.typed-refused-${i}`, {
            schema: S,
            params: { window: parser },
          }),
        ).toThrow(new RegExp(`parsed by a ${kind}`));
      });
    });

    test("a parser that accepts undefined throws at declaration (every typed param is required)", () => {
      expect(() =>
        liveValue("test.live-value.typed-optional", {
          schema: S,
          // An untyped caller: `.optional()`'s output admits undefined (tsc).
          params: { id: z.string().optional() as unknown as z.ZodString },
        }),
      ).toThrow(/accepts undefined/);
    });

    test("an empty record throws at declaration", () => {
      expect(() =>
        liveValue("test.live-value.typed-empty", { schema: S, params: {} }),
      ).toThrow(/empty params record/);
    });

    test("the backstop: a parser that slips a transform past the walk throws a plain Error at the gate", () => {
      // A hand-rolled ZodType whose _parse changes the value: no refused kind
      // in its `_def`, so only the gate's `data !== v` can catch it.
      class Upper extends z.ZodType<string, z.ZodTypeDef, unknown> {
        _parse(input: z.ParseInput): z.ParseReturnType<string> {
          if (typeof input.data === "string") {
            return z.OK(input.data.toUpperCase());
          }
          z.addIssueToContext(this._getOrReturnCtx(input), {
            code: z.ZodIssueCode.custom,
            message: "not a string",
          });
          return z.INVALID;
        }
      }
      const sneaky = liveValue("test.live-value.typed-backstop", {
        schema: S,
        params: { id: new Upper({}) },
      });
      let thrown: unknown;
      try {
        sneaky.validateParams({ id: "a" });
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(Error);
      expect(thrown).not.toBeInstanceOf(ResourceContractError);
      expect(String(thrown)).toMatch(/must return the wire string unchanged/);
      // A value it returns unchanged passes.
      expect(() => sneaky.validateParams({ id: "A" })).not.toThrow();
    });

    test("types: a parsers record typed with an index signature is refused", () => {
      // Its `P` would be `{ [k: string]: string }`, which `useLive` would read
      // as param-less — a read the gate always refuses. Never called.
      const loose: Record<string, z.ZodString> = { id: z.string() };
      const typeOnly = () =>
        liveValue("test.live-value.typed-index-signature", {
          schema: S,
          // @ts-expect-error — the param names must be literal keys
          params: loose,
        });
      expect(typeof typeOnly).toBe("function");
    });

    test("types: a parser whose output is not a string is refused", () => {
      // Never called — the assertion is the `@ts-expect-error`.
      const typeOnly = () =>
        liveValue("test.live-value.typed-number", {
          schema: S,
          // @ts-expect-error — a typed param's parser outputs a string
          params: { n: z.number() },
        });
      expect(typeof typeOnly).toBe("function");
    });
  });

  describe("refusals", () => {
    test("a zod enum or a const list: the descriptor lists the codes, and refuse() mints the refusal", () => {
      const viaEnum = liveValue("test.live-value.refusals-enum", {
        schema: S,
        params: ["path"],
        refusals: z.enum(["missing", "denied"]),
      });
      expect(viaEnum.refusals).toEqual(["missing", "denied"]);
      const viaList = liveValue("test.live-value.refusals-list", {
        schema: S,
        refusals: ["missing", "too-large"],
      });
      expect(viaList.refusals).toEqual(["missing", "too-large"]);
      const err = viaList.refuse("too-large", "over 5 MB");
      expect(err).toBeInstanceOf(ResourceRefusal);
      expect(err.code).toBe("too-large");
      expect(err.message).toBe("over 5 MB");
    });

    test("every form takes them — a typed-query and a paged value too", () => {
      const q = liveValue("test.live-value.refusals-query", {
        schema: S,
        query: z.object({ id: z.string() }),
        refusals: ["missing"],
      });
      expect(q.refusals).toEqual(["missing"]);
      const paged = liveValue("test.live-value.refusals-paged", {
        query: z.object({ id: z.string() }),
        paged: {
          item: z.object({ id: z.string() }),
          id: "id",
          key: { of: (i: { id: string }) => [i.id], order: ["asc"] },
          limit: 10,
          maxLimit: 20,
        },
        refusals: ["missing"],
      });
      expect(paged.refusals).toEqual(["missing"]);
    });

    test("a paged value's meta sibling carries the same codes, typed by the declaration", () => {
      const paged = liveValue("test.live-value.refusals-paged-meta", {
        query: z.object({ id: z.string() }),
        paged: {
          item: z.object({ id: z.string() }),
          id: "id",
          key: { of: (i: { id: string }) => [i.id], order: ["asc"] },
          limit: 10,
          maxLimit: 20,
          meta: z.object({ total: z.number() }),
        },
        refusals: ["invalid-query"],
      });
      // Typed `readonly "invalid-query"[] | undefined` — what `useLive`'s
      // `RefusalsDecl<C>` infers a meta read's `error.code` from.
      const codes: readonly "invalid-query"[] | undefined = paged.meta.refusals;
      // @ts-expect-error — not a declared code
      const wrong: readonly "other"[] | undefined = paged.meta.refusals;
      void wrong;
      expect(codes).toEqual(["invalid-query"]);
    });

    test("none declared: no codes and no refuse", () => {
      const v = liveValue("test.live-value.refusals-none", { schema: S });
      expect(v.refusals).toBeUndefined();
      expect(v.refuse).toBeUndefined();
    });

    test("refused at declaration: an empty list, an empty code, a duplicate", () => {
      for (const refusals of [[], [""], ["a", "a"]]) {
        expect(() =>
          liveValue("test.live-value.refusals-bad", {
            schema: S,
            refusals: refusals as unknown as readonly [string, ...string[]],
          }),
        ).toThrow(/refusals/);
      }
    });

    test("refuse() refuses an undeclared code for an untyped caller", () => {
      const v = liveValue("test.live-value.refusals-untyped", {
        schema: S,
        refusals: ["missing"],
      });
      const refuse = v.refuse as (code: string, message: string) => unknown;
      expect(() => refuse("gone", "x")).toThrow(/not a declared refusal/);
    });
  });
});

// The markers' own forms are list-bound's to test; here a native cap, a
// finite-keyed record and `wholeList` stand for the bounded lists.
describe("liveValue — the declared list shape", () => {
  const Row = z.object({
    id: z.string(),
    segments: wholeList(z.string(), { reason: "one row's handful of tags" }),
    flags: z.record(z.enum(["a", "b"]), z.boolean()),
  });

  test("a plain value's shape is its schema's lists, each with its bound", () => {
    const v = liveValue("test.live-value.shape.plain", {
      schema: z.object({
        rows: z.array(Row).max(500),
        truncated: z.boolean(),
      }),
    });
    expect(v.shape).toEqual({
      paged: false,
      bounds: [
        { path: "rows", max: 500 },
        { path: "rows[].segments", reason: "one row's handful of tags" },
        { path: "rows[].flags", max: 2 },
      ],
      bare: [],
    });
    expect(Object.isFrozen(v.shape)).toBe(true);
    expect(Object.isFrozen(v.shape.bounds)).toBe(true);
  });

  test("a bare list is refused at declaration, naming the key and every path", () => {
    expect(() =>
      liveValue("test.live-value.shape.bare", {
        schema: z.object({
          rows: z.array(z.object({ segments: z.array(z.string()) })).max(5),
          byKind: z.record(z.string(), z.number()),
        }),
      }),
    ).toThrow(
      /liveValue\("test\.live-value\.shape\.bare"\).*`rows\[\]\.segments`, `byKind`/,
    );
    // Refused before it registers: nothing under the key.
    expect(
      resourceDescriptorByKey("test.live-value.shape.bare"),
    ).toBeUndefined();
  });

  test("the bound is the declaration's, whatever serves it: a top-level array or string-keyed record is refused, a marked one declares", () => {
    // What the retired serve-side `unbounded` (db arm only) asked of a
    // collection-shaped payload is now asked of EVERY value's schema.
    expect(() =>
      liveValue("test.live-value.shape.top-array", {
        schema: z.array(z.string()),
      }),
    ).toThrow(/top-array.*`\(root\)`/);
    expect(() =>
      liveValue("test.live-value.shape.top-record", {
        schema: z.record(z.string(), z.number()),
      }),
    ).toThrow(/top-record.*`\(root\)`/);
    expect(() =>
      liveValue("test.live-value.shape.nullable-array", {
        schema: z.array(z.string()).nullable(),
      }),
    ).toThrow(/nullable-array.*`\(root\)`/);
    const names = liveValue("test.live-value.shape.top-whole", {
      schema: wholeList(z.string(), { reason: "one row per configured host" }),
    });
    expect(names.shape.bounds).toEqual([
      { path: "(root)", reason: "one row per configured host" },
    ]);
    const byHost = liveValue("test.live-value.shape.top-whole-record", {
      schema: wholeRecord(z.number(), { reason: "one entry per host" }),
    });
    expect(byHost.shape.bounds).toEqual([
      { path: "(root)", reason: "one entry per host" },
    ]);
  });

  test("a value with no list has an empty shape", () => {
    expect(
      liveValue("test.live-value.shape.none", { schema: S }).shape,
    ).toEqual({ paged: false, bounds: [], bare: [] });
  });

  test("a typed-query value's shape is its answer's, never its question's", () => {
    const v = liveValue("test.live-value.shape.query", {
      schema: z.array(z.number()).max(3),
      query: z.object({ ids: z.array(z.string()) }),
    });
    expect(v.shape).toEqual({
      paged: false,
      bounds: [{ path: "(root)", max: 3 }],
      bare: [],
    });
    expect(() =>
      liveValue("test.live-value.shape.query-bare", {
        schema: z.array(z.number()),
        query: z.object({ ids: z.array(z.string()) }),
      }),
    ).toThrow(/test\.live-value\.shape\.query-bare.*`\(root\)`/);
  });

  test("a paged value's shape is its item's lists under `[]`, its meta its own", () => {
    const v = liveValue("test.live-value.shape.paged", {
      query: z.object({ list: z.string() }),
      paged: {
        item: Row,
        id: "id",
        key: { of: (i) => [i.id], order: ["asc"] },
        limit: 5,
        maxLimit: 10,
        meta: z.object({
          hosts: wholeRecord(z.number(), { reason: "one entry per host" }),
        }),
      },
    });
    expect(v.shape).toEqual({
      paged: true,
      bounds: [
        { path: "[].segments", reason: "one row's handful of tags" },
        { path: "[].flags", max: 2 },
      ],
      bare: [],
    });
    expect(v.meta.shape).toEqual({
      paged: false,
      bounds: [{ path: "hosts", reason: "one entry per host" }],
      bare: [],
    });
  });

  test("a paged value's bare item list or meta list is refused", () => {
    const paged = (key: string, item: z.AnyZodObject, meta?: z.ZodTypeAny) =>
      liveValue(key, {
        query: z.object({ list: z.string() }),
        paged: {
          item,
          id: "id",
          key: { of: (i: { id: string }) => [i.id], order: ["asc"] },
          limit: 5,
          maxLimit: 10,
          ...(meta !== undefined ? { meta } : {}),
        },
      } as never);
    expect(() =>
      paged(
        "test.live-value.shape.paged-bare-item",
        z.object({ id: z.string(), xs: z.array(z.string()) }),
      ),
    ).toThrow(/paged-bare-item.*`\[\]\.xs`/);
    expect(() =>
      paged(
        "test.live-value.shape.paged-bare-meta",
        z.object({ id: z.string() }),
        z.object({ hosts: z.record(z.number()) }),
      ),
    ).toThrow(/paged-bare-meta.*`hosts`/);
  });

  test("a bytes value holds no list", () => {
    const v = liveValue("test.live-value.shape.bytes", {
      bytes: true,
      params: ["path"],
    });
    expect(v.shape).toEqual({ paged: false, bounds: [], bare: [] });
  });

  test("a malformed marker throws at declaration, naming the key and the path", () => {
    const xs = z.array(z.string());
    (xs._def as unknown as Record<string, unknown>).listBound = { reason: "" };
    expect(() =>
      liveValue("test.live-value.shape.malformed", {
        schema: z.object({ xs }),
      }),
    ).toThrow(/liveValue\("test\.live-value\.shape\.malformed"\).*`xs`/);
  });
});
