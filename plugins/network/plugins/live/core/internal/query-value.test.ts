import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { resourceDescriptorByKey } from "@plugins/primitives/plugins/live-state/core";
import { ResourceContractError } from "@plugins/packages/plugins/resource-protocol/core";
import {
  liveValue,
  type LivePagedSpec,
  type LivePagedValueSpec,
  type LiveQueryValueSpec,
} from "./live-value";
import { LIVE_QUERY_MAX_BYTES } from "./query-value";

const Result = z.object({ n: z.number() });
const Query = z.object({
  metric: z.string(),
  range: z.object({ preset: z.enum(["7d", "30d"]) }),
  tz: z.string().default("UTC"),
});

let seq = 0;
const key = (name: string) => `test.query-value.${name}.${seq++}`;

/** The gate's verdict on a tuple: ok, or the contract error's detail. */
function gate(
  v: { validateParams: (p: Record<string, string>) => void },
  params: Record<string, string>,
): "ok" | string {
  try {
    v.validateParams(params);
    return "ok";
  } catch (err) {
    if (err instanceof ResourceContractError) return err.detail;
    throw err;
  }
}

describe("liveValue — typed query", () => {
  test("declares a { q } value with its codec, registered", () => {
    const k = key("declare");
    const v = liveValue(k, { schema: Result, query: Query, load: "on-demand" });
    expect(v.live).toBe("value");
    expect(v.params).toEqual(["q"]);
    expect(v.load).toBe("on-demand");
    expect(v.preload).toBeUndefined();
    expect(resourceDescriptorByKey(k)).toBe(v);
  });

  test("encode then decode round-trips; key order and defaults fold into one tuple", () => {
    const v = liveValue(key("roundtrip"), { schema: Result, query: Query });
    const a = v.query.encode({ metric: "m", range: { preset: "7d" } });
    const b = v.query.encode({
      range: { preset: "7d" },
      metric: "m",
      tz: "UTC",
    });
    expect(a).toEqual(b);
    expect(a.q).toBe('{"metric":"m","range":{"preset":"7d"},"tz":"UTC"}');
    expect(v.query.decode(a)).toEqual({
      metric: "m",
      range: { preset: "7d" },
      tz: "UTC",
    });
    expect(gate(v, a)).toBe("ok");
  });

  test.each<[string, Record<string, string>, RegExp]>([
    [
      "a non-canonical q (key order)",
      { q: '{"range":{"preset":"7d"},"metric":"m","tz":"UTC"}' },
      /not canonical/,
    ],
    [
      "a q missing a default",
      { q: '{"metric":"m","range":{"preset":"7d"}}' },
      /not canonical/,
    ],
    [
      "an extra key",
      { q: '{"metric":"m","range":{"preset":"7d"},"tz":"UTC"}', x: "1" },
      /unknown param "x"/,
    ],
    ["a missing q", {}, /missing param "q"/],
    ["q not JSON", { q: "{" }, /not JSON/],
    [
      "a schema failure",
      { q: '{"metric":"m","range":{"preset":"1y"},"tz":"UTC"}' },
      /refused by the query schema/,
    ],
  ])("%s is a contract mismatch", (_name, params, detail) => {
    const v = liveValue(key("gate"), { schema: Result, query: Query });
    expect(gate(v, params)).toMatch(detail);
  });

  test("a schema whose parse is not idempotent is refused by the equality check", () => {
    const v = liveValue(key("transform"), {
      schema: Result,
      query: z.object({ n: z.number().transform((n) => n + 1) }),
    });
    // Encoding parses once ({ n: 1 } → { n: 2 }); the gate parses the wire
    // value again ({ n: 2 } → { n: 3 }), which is not the tuple.
    const params = v.query.encode({ n: 1 });
    expect(params.q).toBe('{"n":2}');
    expect(gate(v, params)).toMatch(/not canonical/);
  });

  test("a refinement passes — it checks, it does not rewrite", () => {
    const v = liveValue(key("refine"), {
      schema: Result,
      query: z.object({ tz: z.string().refine((s) => s !== "nope") }),
    });
    expect(gate(v, v.query.encode({ tz: "UTC" }))).toBe("ok");
    expect(() => v.query.encode({ tz: "nope" })).toThrow(
      /refused by its schema/,
    );
  });

  test("encoding a query the schema refuses throws a plain Error", () => {
    const v = liveValue(key("refused"), { schema: Result, query: Query });
    const bad = { metric: 1, range: { preset: "7d" } } as unknown as z.input<
      typeof Query
    >;
    expect(() => v.query.encode(bad)).toThrow(/refused by its schema/);
    expect(() => v.query.encode(bad)).not.toThrow(ResourceContractError);
  });

  test("encoding past LIVE_QUERY_MAX_BYTES throws", () => {
    const v = liveValue(key("size"), {
      schema: Result,
      query: z.object({ s: z.string() }),
    });
    expect(() =>
      v.query.encode({ s: "x".repeat(LIVE_QUERY_MAX_BYTES) }),
    ).toThrow(/LIVE_QUERY_MAX_BYTES/);
    expect(
      gate(v, { q: JSON.stringify({ s: "x".repeat(LIVE_QUERY_MAX_BYTES) }) }),
    ).toMatch(/over LIVE_QUERY_MAX_BYTES/);
  });

  test("a central query value carries its origin", () => {
    const v = liveValue(key("central"), {
      schema: Result,
      query: Query,
      origin: "central",
    });
    expect(v.origin).toBe("central");
  });

  test("types: query excludes params and preload", () => {
    type Spec = LiveQueryValueSpec<
      z.output<typeof Result>,
      z.output<typeof Query>,
      z.input<typeof Query>,
      "worktree"
    >;
    const both: Spec = {
      schema: Result,
      query: Query,
      // @ts-expect-error — `query` and `params` cannot both be declared
      params: ["id"],
    };
    const preloaded: Spec = {
      schema: Result,
      query: Query,
      // @ts-expect-error — a query value has no default tuple to preload
      preload: "boot",
    };
    expect([both, preloaded]).toHaveLength(2);
  });

  test("an untyped caller's stray params / preload throw", () => {
    expect(() =>
      liveValue(key("stray"), {
        schema: Result,
        query: Query,
        params: ["id"],
      } as never),
    ).toThrow(/cannot be declared beside `query`/);
  });
});

describe("liveValue — paged", () => {
  const Item = z.object({ id: z.string(), title: z.string(), at: z.string() });
  const Meta = z.object({ total: z.number() });
  const Selector = z.object({ metric: z.string() });
  const paged = (
    extra: Partial<Omit<LivePagedSpec<Item, undefined>, "meta">> = {},
  ) => ({
    item: Item,
    id: "id" as const,
    key: { of: (i: Item) => [i.at], order: ["desc"] as const },
    limit: 50,
    maxLimit: 100,
    ...extra,
  });
  type Item = z.output<typeof Item>;

  test("declares a { q, limit, after?, until? } value with a derived page schema", () => {
    const v = liveValue(key("paged"), { query: Selector, paged: paged() });
    expect(v.params).toEqual(["q", "limit", "after", "until"]);
    expect(v.optionalParams).toEqual(["after", "until"]);
    expect(v.paged).toMatchObject({ id: "id", limit: 50, maxLimit: 100 });
    expect(v.meta).toBeUndefined();
    const row = { id: "a", title: "A", at: "t1", $key: '["t1","a"]' };
    // The wire row keeps its `$key` beside the item's fields.
    expect(v.schema.parse([row])).toEqual([row]);
    expect(() => v.schema.parse([{ id: "a", title: "A", at: "t1" }])).toThrow();
  });

  test("declared paged.meta, the value carries its per-question sibling", () => {
    const v = liveValue(key("paged-meta"), {
      query: Selector,
      paged: { ...paged(), meta: Meta },
    });
    expect(v.meta.key).toBe(`${v.key}:meta`);
    expect(v.meta.params).toEqual(["q"]);
    // Pushed, like the pages.
    expect(v.meta.load).toBeUndefined();
    expect(v.meta.query.encode({ metric: "m" })).toEqual({
      q: '{"metric":"m"}',
    });
    expect(resourceDescriptorByKey(v.meta.key)).toBe(v.meta);
  });

  test("a page is a keyed window: its descriptor is keyed by the item's id, and no `load` is declared beside `paged`", () => {
    const v = liveValue(key("paged-keyed"), {
      query: Selector,
      paged: paged(),
    });
    expect(v.load).toBeUndefined();
    expect(v.keyed.keyOf({ id: "a", title: "A", at: "t1", $key: null })).toBe(
      "a",
    );
    // A keyed page is always pushed (deltas): `load` is `never` beside `paged`.
    const onDemand = {
      query: Selector,
      paged: paged(),
      load: "on-demand" as const,
    };
    expect(() =>
      // @ts-expect-error — no overload takes `load` beside `paged`
      liveValue(key("paged-on-demand"), onDemand),
    ).toThrow(/a paged value takes no `load`/);
  });

  test("page 0 is { q, limit }; a page tuple round-trips to its key range", () => {
    const v = liveValue(key("paged-rt"), { query: Selector, paged: paged() });
    const first = v.query.encode(
      { metric: "m" },
      { after: null, until: null, limit: 50 },
    );
    expect(first).toEqual({ q: '{"metric":"m"}', limit: "50" });
    const mid = v.query.encode(
      { metric: "m" },
      { after: '["t9","a"]', until: '[null,"b"]', limit: 100 },
    );
    expect(mid).toEqual({
      q: '{"metric":"m"}',
      limit: "100",
      after: '["t9","a"]',
      until: '[null,"b"]',
    });
    expect(v.query.decode(mid)).toEqual({
      query: { metric: "m" },
      range: {
        after: { key: ["t9"], id: "a" },
        until: { key: [null], id: "b" },
        limit: 100,
      },
    });
    expect(gate(v, first)).toBe("ok");
    expect(gate(v, mid)).toBe("ok");
  });

  test.each<[string, Record<string, string>, RegExp]>([
    [
      "limit over maxLimit",
      { q: '{"metric":"m"}', limit: "101" },
      /not an integer in 1..100/,
    ],
    ["limit zero", { q: '{"metric":"m"}', limit: "0" }, /not an integer/],
    [
      "limit non-canonical",
      { q: '{"metric":"m"}', limit: "05" },
      /not an integer/,
    ],
    ["limit missing", { q: '{"metric":"m"}' }, /missing param "limit"/],
    [
      "a cut of the wrong arity",
      { q: '{"metric":"m"}', limit: "5", after: '["a"]' },
      /row key of 2 text values/,
    ],
    [
      "a cut with a NULL id",
      { q: '{"metric":"m"}', limit: "5", until: '["t",null]' },
      /row key of 2 text values/,
    ],
    [
      "a non-canonical cut",
      { q: '{"metric":"m"}', limit: "5", after: '["t", "a"]' },
      /not canonical/,
    ],
    [
      "an over-long cut",
      {
        q: '{"metric":"m"}',
        limit: "5",
        after: JSON.stringify(["x".repeat(1100), "a"]),
      },
      /over 1024 bytes/,
    ],
    [
      "a cursor (the old tuple)",
      { q: '{"metric":"m"}', limit: "5", c: "abc" },
      /unknown param "c"/,
    ],
    [
      "a non-canonical q",
      { q: '{ "metric":"m"}', limit: "5" },
      /not canonical/,
    ],
  ])("%s is a contract mismatch", (_name, params, detail) => {
    const v = liveValue(key("paged-gate"), { query: Selector, paged: paged() });
    expect(gate(v, params)).toMatch(detail);
  });

  test("encoding a page over maxLimit, or a malformed cut, throws a plain Error", () => {
    const v = liveValue(key("paged-big"), { query: Selector, paged: paged() });
    expect(() =>
      v.query.encode({ metric: "m" }, { after: null, until: null, limit: 101 }),
    ).toThrow(/page limit 101/);
    expect(() =>
      v.query.encode({ metric: "m" }, { after: "x", until: null, limit: 5 }),
    ).toThrow(/invalid JSON/);
  });

  test.each<
    [string, Partial<Omit<LivePagedSpec<Item, undefined>, "meta">>, RegExp]
  >([
    ["a non-positive limit", { limit: 0 }, /paged.limit 0/],
    [
      "maxLimit under 2 · limit",
      { limit: 50, maxLimit: 99 },
      /≥ 2 · paged.limit/,
    ],
    [
      "a bad order direction",
      { key: { of: (i) => [i.at], order: ["up" as "asc"] } },
      /paged.key needs/,
    ],
    [
      "an item declaring $key",
      { item: Item.extend({ $key: z.string() }) as unknown as typeof Item },
      /"\$key" is reserved/,
    ],
  ])("%s throws at declaration", (_name, extra, message) => {
    expect(() =>
      liveValue(key("paged-decl"), { query: Selector, paged: paged(extra) }),
    ).toThrow(message);
  });

  test("types: the id is a string field; a key part is text or null; no schema beside paged", () => {
    type Paged = LivePagedSpec<Item, undefined>;
    const ok: Paged["id"] = "title";
    // @ts-expect-error — `title2` is not a field of the item
    const bad: Paged["id"] = "title2";
    const numericKey: Paged["key"] = {
      // @ts-expect-error — a key part is exact text (the source fixes its precision), never a number
      of: (i: Item) => [i.title.length],
      order: ["asc"],
    };
    type Spec = LivePagedValueSpec<
      Item,
      undefined,
      z.output<typeof Selector>,
      z.input<typeof Selector>,
      "worktree"
    >;
    const withSchema: Spec = {
      // @ts-expect-error — a paged value's schema is derived
      schema: Result,
      query: Selector,
      paged: paged(),
    };
    expect([ok, bad, numericKey, withSchema]).toHaveLength(4);
  });
});
