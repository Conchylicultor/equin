import { describe, expect, test } from "bun:test";
import type { z } from "zod";
import { fieldsToZodObject } from "@plugins/fields/core";
import { intField } from "@plugins/fields/plugins/int/plugins/config/core";
import { textField } from "@plugins/fields/plugins/text/plugins/config/core";
import { ResourceContractError } from "@plugins/packages/plugins/resource-protocol/core";
import { resourceDescriptorByKey } from "@plugins/primitives/plugins/live-state/core";
import {
  liveCollection,
  type LiveAllCollection,
  type LiveLookupCollection,
  type LiveRowsCollection,
} from "./live-collection";

const F = {
  id: textField({ label: "Id" }),
  n: intField({ label: "N" }),
};
const Row = fieldsToZodObject(F);

describe("liveCollection — lookup-only (no default window)", () => {
  test("mints only the :rows point descriptor: no window, no groups, nothing else registered", () => {
    const c = liveCollection("test.live-collection.lookup", {
      fields: F,
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
      fields: F,
      id: "id",
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
      fields: F,
      id: "id",
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
        fields: F,
        id: "id",
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
        fields: F,
        id: "id",
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
      liveCollection("test.types.a", { fields: F, id: "id", preload: "boot" });
      // @ts-expect-error — no order to sort without a default window
      liveCollection("test.types.b", { fields: F, id: "id", sortable: ["n"] });
      // @ts-expect-error — no list read would ever read a filter declaration
      liveCollection("test.types.c", { fields: F, id: "id", filterable: {} });
    };
    void _typesOnly;
  });

  test("an untyped half-window declaration throws instead of minting a lookup", () => {
    expect(() =>
      liveCollection("test.live-collection.half", {
        fields: F,
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
      fields: F,
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
      fields: F,
      id: "id",
      all,
      preload: "none",
    });
    expect("preload" in c.all).toBe(false);
  });

  test("any param is a contract mismatch; the `{}` tuple passes", () => {
    const c = liveCollection("test.live-collection.all-params", {
      fields: F,
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
    const base = { fields: F, id: "id", all };
    const cases: [Record<string, unknown>, RegExp][] = [
      [
        { ...base, default: { orderBy: [["n", "asc"]], limit: 1 } },
        /default, filterable beside `all`/,
      ],
      [
        { ...base, sortable: ["n"], maxLimit: 5 },
        /sortable, maxLimit beside `all`/,
      ],
      [{ ...base, contributed: true }, /`contributed` no longer exists/],
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
      const s = { fields: F, id: "id", all } as const;
      const order = { unbounded: { reason: "r" } } as const;
      // @ts-expect-error — the whole set has no window
      liveCollection("t.a", { ...s, sortable: ["n"] });
      // @ts-expect-error — nor a cap
      liveCollection("t.c", { ...s, maxLimit: 5 });
      const bad = { ...order, orderBy: [["x", "asc"]] } as const;
      // @ts-expect-error — an order field must be a row field
      liveCollection("t.e", { ...s, all: bad });
      const noBound = { orderBy: [["n", "asc"]] } as const;
      // @ts-expect-error — `unbounded` is required: the set has no other bound
      liveCollection("t.f", { ...s, all: noBound });
      const w = { sortable: ["n"], maxLimit: 1 } as const;
      const d = { orderBy: [["n", "asc"]], limit: 1 } as const;
      // @ts-expect-error — a window collection is not also the whole set
      liveCollection("t.g", { ...s, ...w, default: d });
      const whole = liveCollection("t.h", { fields: F, id: "id", all });
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

describe("liveCollection — a scoped `all` (`all: { by }`)", () => {
  const FS = {
    id: textField({ label: "Id" }),
    pageId: textField({ label: "Page" }),
    n: intField({ label: "N" }),
  };
  const ScopedRow = fieldsToZodObject(FS);
  const all = {
    by: ["pageId"],
    orderBy: [["n", "asc"]],
    unbounded: { reason: "one page's rows" },
  } as const;

  test("mints `key` keyed by its scope — no preload — and a global :rows", () => {
    const c = liveCollection("test.live-collection.scoped", {
      fields: FS,
      id: "id",
      all,
    });
    expect(c.all.all).toEqual({
      orderBy: [["n", "asc"]],
      unbounded: { reason: "one page's rows" },
      by: ["pageId"],
    });
    expect("preload" in c.all).toBe(false);
    expect(resourceDescriptorByKey("test.live-collection.scoped")).toBe(c.all);
    // `:rows` is the collection's id read, whatever the scope.
    expect(() => c.rows.validateParams({ ids: "a" })).not.toThrow();
  });

  test("a tuple is exactly the scope's keys, each a non-empty string — anything else is a contract mismatch", () => {
    const c = liveCollection("test.live-collection.scoped-params", {
      fields: FS,
      id: "id",
      all,
    });
    expect(() => c.all.validateParams({ pageId: "p1" })).not.toThrow();
    const cases: [Record<string, string>, RegExp][] = [
      [{}, /param "pageId" must be a non-empty string, got undefined/],
      [{ pageId: "" }, /param "pageId" must be a non-empty string, got ""/],
      [
        { pageId: "p1", n: "1" },
        /unknown param "n" — a tuple of this scoped set is exactly "pageId"/,
      ],
    ];
    for (const [params, message] of cases) {
      let thrown: unknown;
      try {
        c.all.validateParams(params);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(ResourceContractError);
      expect(String(thrown)).toMatch(message);
    }
  });

  test("runtime throws for an untyped caller: an empty `by`, a non-row field, the id, a repeat, a preload", () => {
    const base = { fields: FS, id: "id", all };
    const cases: [Record<string, unknown>, RegExp][] = [
      [{ ...base, all: { ...all, by: [] } }, /`all.by` is empty/],
      [
        { ...base, all: { ...all, by: ["nope"] } },
        /`all.by` names "nope", which is not a field of the row schema/,
      ],
      [
        { ...base, all: { ...all, by: ["id"] } },
        /`all.by` names the id "id" — a scope of one row is a point read/,
      ],
      [
        { ...base, all: { ...all, by: ["pageId", "pageId"] } },
        /`all.by` names "pageId" twice/,
      ],
      [
        { ...base, preload: "boot" },
        /`preload: "boot"` beside `all.by` — a scoped set's tuples are named by its readers/,
      ],
    ];
    let i = 0;
    for (const [spec, message] of cases) {
      expect(() =>
        liveCollection(`test.live-collection.scoped-bad-${i++}`, spec as never),
      ).toThrow(message);
    }
  });

  test("types: a preload or a non-row field beside `by` is a tsc error, and a scoped set is never the whole one", () => {
    // Never called — the assertions are the `@ts-expect-error`s.
    const _typesOnly = () => {
      const s = { fields: FS, id: "id", all } as const;
      // @ts-expect-error — a scoped set is never preloaded
      liveCollection("t.s.a", { ...s, preload: "boot" });
      const bad = { ...all, by: ["nope"] } as const;
      // @ts-expect-error — a scope field must be a row field
      liveCollection("t.s.b", { ...s, all: bad });
      type R = z.infer<typeof ScopedRow>;
      const scoped = liveCollection("t.s.c", s);
      const _ok: LiveAllCollection<R, "pageId"> = scoped;
      // @ts-expect-error — a scoped set is not the param-less whole set
      const _whole: LiveAllCollection<R> = scoped;
      const whole = liveCollection("t.s.d", {
        fields: FS,
        id: "id",
        all: { orderBy: [["n", "asc"]], unbounded: { reason: "r" } },
      });
      // @ts-expect-error — nor the whole set a scoped one
      const _scoped: LiveAllCollection<R, "pageId"> = whole;
      // Read by id like any collection.
      const _rows: LiveRowsCollection<R> = scoped;
      void [_ok, _whole, _scoped, _rows];
    };
    void _typesOnly;
  });
});
