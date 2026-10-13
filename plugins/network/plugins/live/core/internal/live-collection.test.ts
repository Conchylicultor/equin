import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { ResourceContractError } from "@plugins/packages/plugins/resource-protocol/core";
import { resourceDescriptorByKey } from "@plugins/primitives/plugins/live-state/core";
import {
  liveCollection,
  type LiveLookupCollection,
  type LiveRowsCollection,
} from "./live-collection";

const Row = z.object({ id: z.string(), n: z.number() });

describe("liveCollection — lookup-only (no default window)", () => {
  test("mints only the :rows point descriptor: no window, no groups, nothing else registered", () => {
    const c = liveCollection("test.live-collection.lookup", {
      row: Row,
      id: "id",
    });
    expect(c.rows.key).toBe("test.live-collection.lookup:rows");
    expect(c.window).toBeUndefined();
    expect(c.groups).toBeUndefined();
    expect(c.rowKeys).toEqual(["id", "n"]);
    expect(resourceDescriptorByKey("test.live-collection.lookup:rows")).toBe(
      c.rows,
    );
    expect(resourceDescriptorByKey("test.live-collection.lookup")).toBe(
      undefined,
    );
    expect(resourceDescriptorByKey("test.live-collection.lookup:groups")).toBe(
      undefined,
    );
    // The point codec is the full collection's: one id encodes to itself.
    expect(c.rows.point.encode(["b", "a"])).toEqual({ ids: "a,b" });
  });

  test("a full collection still mints all three", () => {
    const c = liveCollection("test.live-collection.full", {
      row: Row,
      id: "id",
      filterable: {},
      sortable: ["n"],
      default: { orderBy: [["n", "asc"]], limit: 10 },
      maxLimit: 50,
    });
    expect(resourceDescriptorByKey("test.live-collection.full")).toBe(c.window);
    expect(resourceDescriptorByKey("test.live-collection.full:rows")).toBe(
      c.rows,
    );
    expect(resourceDescriptorByKey("test.live-collection.full:groups")).toBe(
      c.groups,
    );
  });

  test("every window pages: its rows carry `$key` on the wire, and its maxLimit leaves a split's headroom", () => {
    const c = liveCollection("test.live-collection.paged", {
      row: Row,
      id: "id",
      filterable: {},
      sortable: ["n"],
      default: { orderBy: [["n", "asc"]], limit: 10 },
      maxLimit: 20,
    });
    // The wire schema keeps each row's server-minted key (null: uncuttable);
    // a row without one is no window row.
    const wire = c.window.schema.parse([
      { id: "a", n: 1, $key: '["1","a"]' },
      { id: "b", n: 2, $key: null },
    ]) as Record<string, unknown>[];
    expect(wire.map((r) => r.$key)).toEqual(['["1","a"]', null]);
    expect(() => c.window.schema.parse([{ id: "a", n: 1 }])).toThrow();
    // The point sibling's rows carry none: a key is a window position.
    expect(c.rows.schema.parse([{ id: "a", n: 1 }])).toEqual([
      { id: "a", n: 1 },
    ]);
    expect(() =>
      liveCollection("test.live-collection.tight", {
        row: Row,
        id: "id",
        filterable: {},
        sortable: ["n"],
        default: { orderBy: [["n", "asc"]], limit: 10 },
        maxLimit: 19,
      }),
    ).toThrow(/maxLimit must be ≥ 2 · default.limit \(20\), got 19/);
  });

  test("types: `scroll` is no declaration field — a stray one is a tsc error", () => {
    // Never called — the assertions are the `@ts-expect-error`s.
    const _typesOnly = () => {
      const w = {
        row: Row,
        id: "id",
        filterable: {},
        sortable: ["n"],
        default: { orderBy: [["n", "asc"]], limit: 1 },
        maxLimit: 2,
      } as const;
      // @ts-expect-error — every window pages; there is nothing to declare
      liveCollection("test.types.scroll", { ...w, scroll: true });
      const arms = { discriminator: "n" } as const;
      // @ts-expect-error — nor on a union
      liveCollection("test.types.scroll-arms", { ...w, arms, scroll: true });
    };
    void _typesOnly;
  });

  test("types: a window field without `default`, and any preload, are tsc errors", () => {
    // Never called — the assertions are the `@ts-expect-error`s.
    const _typesOnly = () => {
      // @ts-expect-error — an id set has no default tuple to preload
      liveCollection("test.types.a", { row: Row, id: "id", preload: "boot" });
      // @ts-expect-error — no order to sort without a default window
      liveCollection("test.types.b", { row: Row, id: "id", sortable: ["n"] });
      // @ts-expect-error — no list read would ever read a filter declaration
      liveCollection("test.types.c", { row: Row, id: "id", filterable: {} });
    };
    void _typesOnly;
  });

  test("an untyped half-window declaration throws instead of minting a lookup", () => {
    expect(() =>
      liveCollection("test.live-collection.half", {
        row: Row,
        id: "id",
        maxLimit: 10,
      } as never),
    ).toThrow(/maxLimit without `default`/);
  });
});

describe("liveCollection — the `all` overload (C16, C39, T13)", () => {
  const all = {
    orderBy: [["n", "asc"]],
    unbounded: { reason: "a test set" },
  } as const;

  test("mints `key` (the whole ordered set) and :rows — no window, no groups", () => {
    const c = liveCollection("test.live-collection.all", {
      row: Row,
      id: "id",
      all,
      preload: "boot",
    });
    expect(c.all.key).toBe("test.live-collection.all");
    expect(c.rows.key).toBe("test.live-collection.all:rows");
    expect((c as { window?: unknown }).window).toBeUndefined();
    expect((c as { groups?: unknown }).groups).toBeUndefined();
    // Self-registered under `key` (C39) — what boot hydration resolves by.
    expect(resourceDescriptorByKey("test.live-collection.all")).toBe(c.all);
    expect(resourceDescriptorByKey("test.live-collection.all:rows")).toBe(
      c.rows,
    );
    expect(resourceDescriptorByKey("test.live-collection.all:groups")).toBe(
      undefined,
    );
    // Keyed, no default tuple: boot hydrates `{}`.
    expect(c.all.keyed.keyOf({ id: "a", n: 1 })).toBe("a");
    expect("defaultParams" in c.all).toBe(false);
    expect(c.all.preload).toBe("boot");
    expect(c.all.queryPk).toBe("id");
    expect(c.all.all).toEqual({
      orderBy: [["n", "asc"]],
      unbounded: { reason: "a test set" },
    });
  });

  test('`preload: "none"` is the absence of the flag', () => {
    const c = liveCollection("test.live-collection.all-none", {
      row: Row,
      id: "id",
      all,
      preload: "none",
    });
    expect("preload" in c.all).toBe(false);
  });

  test("any param is a contract mismatch; the `{}` tuple passes", () => {
    const c = liveCollection("test.live-collection.all-params", {
      row: Row,
      id: "id",
      all,
    });
    // The `{}` tuple is the one this declaration mints — and also the one a
    // param-less PREDECESSOR of the same key subscribed (the legacy `tasks`).
    // So the gate is no skew signal against that predecessor: an older tab
    // passes it and parses the new rows with its own schema. The conversion
    // steps own that proof (P8 v3, As landed → 16b.3, C39 open item).
    expect(() => c.all.validateParams({})).not.toThrow();
    let thrown: unknown;
    try {
      c.all.validateParams({ limit: "100" });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ResourceContractError);
    expect(String(thrown)).toMatch(/unknown param "limit"/);
  });

  test("runtime throws for an untyped caller: a window or union field, an empty reason or order, a non-row field, a bad direction, a repeat", () => {
    const base = { row: Row, id: "id", all };
    const cases: [Record<string, unknown>, RegExp][] = [
      [
        { ...base, default: { orderBy: [["n", "asc"]], limit: 1 } },
        /default beside `all`/,
      ],
      [
        { ...base, sortable: ["n"], maxLimit: 5 },
        /sortable, maxLimit beside `all`/,
      ],
      [{ ...base, filterable: {} }, /filterable beside `all`/],
      [{ ...base, contributed: true }, /contributed beside `all`/],
      [{ ...base, columnScope: "s" }, /columnScope beside `all`/],
      [{ ...base, arms: { discriminator: "n" } }, /arms beside `all`/],
      [
        { ...base, all: { ...all, unbounded: { reason: " " } } },
        /`all.unbounded.reason` is empty/,
      ],
      [
        { ...base, all: { orderBy: [["n", "asc"]] } },
        /`all.unbounded.reason` is empty/,
      ],
      [{ ...base, all: { ...all, orderBy: [] } }, /`all.orderBy` is empty/],
      [
        { ...base, all: { ...all, orderBy: [["nope", "asc"]] } },
        /names "nope", which is not a field of the row schema/,
      ],
      [
        { ...base, all: { ...all, orderBy: [["n", "up"]] } },
        /sorts "n" "up" — neither "asc" nor "desc"/,
      ],
      [
        {
          ...base,
          all: {
            ...all,
            orderBy: [
              ["n", "asc"],
              ["n", "desc"],
            ],
          },
        },
        /names "n" twice/,
      ],
    ];
    let i = 0;
    for (const [spec, message] of cases) {
      expect(() =>
        liveCollection(`test.live-collection.all-bad-${i++}`, spec as never),
      ).toThrow(message);
    }
  });

  test("types: every window and union field is `never` beside `all`, and `all` beside any other form", () => {
    // Never called — the assertions are the `@ts-expect-error`s.
    // One line per refused call: past one failed overload, TypeScript may
    // report the call itself rather than the field at fault.
    const _typesOnly = () => {
      const s = { row: Row, id: "id", all } as const;
      const order = { unbounded: { reason: "r" } } as const;
      // @ts-expect-error — the whole set has no window
      liveCollection("t.a", { ...s, sortable: ["n"] });
      // @ts-expect-error — nor a filter declaration
      liveCollection("t.b", { ...s, filterable: {} });
      // @ts-expect-error — nor a cap
      liveCollection("t.c", { ...s, maxLimit: 5 });
      const bad = { ...order, orderBy: [["x", "asc"]] } as const;
      // @ts-expect-error — an order field must be a row field
      liveCollection("t.e", { ...s, all: bad });
      const noBound = { orderBy: [["n", "asc"]] } as const;
      // @ts-expect-error — `unbounded` is required: the set has no other bound
      liveCollection("t.f", { ...s, all: noBound });
      const w = { filterable: {}, sortable: ["n"], maxLimit: 1 } as const;
      const d = { orderBy: [["n", "asc"]], limit: 1 } as const;
      // @ts-expect-error — a window collection is not also the whole set
      liveCollection("t.g", { ...s, ...w, default: d });
      const whole = liveCollection("t.h", { row: Row, id: "id", all });
      // @ts-expect-error — a whole set is not a lookup-only collection (serveCollection's lookup arm)
      const _lookup: LiveLookupCollection<z.infer<typeof Row>> = whole;
      // A whole set is still read by id (`useLive(c, { ids })`, `useLiveRow`).
      const _rows: LiveRowsCollection<z.infer<typeof Row>> = whole;
      void _lookup;
      void _rows;
    };
    void _typesOnly;
  });
});
