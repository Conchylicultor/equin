import { describe, expect, it } from "bun:test";
import type { z } from "zod";
import { fieldsToZodObject, nullable } from "@plugins/fields/core";
import { boolField } from "@plugins/fields/plugins/bool/plugins/config/core";
import { intField } from "@plugins/fields/plugins/int/plugins/config/core";
import {
  enumTextField,
  textField,
} from "@plugins/fields/plugins/text/plugins/config/core";
import type { WindowQueryResourceContract } from "@plugins/infra/plugins/query-resource/core";
import {
  and,
  decodeFilter,
  matchesFilter,
  or,
} from "@plugins/network/plugins/live/plugins/filter/core";
import { ResourceContractError } from "@plugins/packages/plugins/resource-protocol/core";
import { liveCollection } from "./live-collection";

const STATUSES = ["running", "error", "idle"] as const;
// The listed fields (filterable); `id`, `count` and `createdAt` ride the row
// without being listed, so they are never filterable.
const LISTED = {
  name: textField({ label: "Name" }),
  status: enumTextField(STATUSES, { label: "Status" }),
  enabled: boolField({ label: "Enabled" }),
};
const CARRIED = {
  id: textField(),
  count: nullable(intField()),
  createdAt: textField(),
};
const F = { fields: LISTED, carry: { fields: CARRIED }, id: "id" } as const;
const RowSchema = fieldsToZodObject({ ...LISTED, ...CARRIED });
type Row = z.infer<typeof RowSchema>;

const sources = liveCollection("live-test.codec", {
  ...F,
  sortable: ["createdAt", "name"],
  default: { orderBy: [["createdAt", "desc"]], limit: 100 },
  maxLimit: 500,
});
const { encode, decode } = sources.window.window;

// Compile-time: the collection's window is still a limit-codec window contract,
// so the existing compiler accepts it unchanged.
const _asContract: WindowQueryResourceContract<Row> = sources.window;

describe("liveCollection", () => {
  it("mints the window key and its :rows and :groups siblings", () => {
    expect(sources.window.key).toBe("live-test.codec");
    expect(sources.rows.key).toBe("live-test.codec:rows");
    expect(sources.groups.key).toBe("live-test.codec:groups");
    expect(sources.rowKeys).toEqual([
      "name",
      "status",
      "enabled",
      "id",
      "count",
      "createdAt",
    ]);
    expect(sources.window.defaultParams).toEqual({ limit: "100" });
    expect(sources.window.window.maxLimit).toBe(500);
    expect(_asContract.window.decode({ limit: "7" }).limit).toBe(7);
  });

  it("rejects an unsortable column, bad operands and a reserved field name", () => {
    // A listed field named like a filter-tree key cannot be filtered on.
    expect(() =>
      liveCollection("live-test.reserved", {
        fields: { or: textField({ label: "Or" }) },
        carry: { fields: { id: textField() } },
        id: "id",
        sortable: [],
        default: { orderBy: [["id", "asc"]], limit: 1 },
        maxLimit: 2,
      }),
    ).toThrow(/cannot be a filterable column/);
    expect(() =>
      // @ts-expect-error — "nope" is not sortable
      encode({ orderBy: [["nope", "asc"]] }),
    ).toThrow(/not a sortable column/);
    // @ts-expect-error — enabled takes a boolean
    expect(() => encode({ where: { enabled: "yes" } })).toThrow();
    // @ts-expect-error — exactly one operator
    expect(() => encode({ where: { name: { gt: "a", lt: "b" } } })).toThrow(
      /exactly one operator/,
    );
    // @ts-expect-error — a boolean column takes no range op
    expect(() => encode({ where: { enabled: { gt: true } } })).toThrow(
      /does not take a boolean column/,
    );
    // @ts-expect-error — status operands are narrowed to its enum in tsc
    expect(encode({ where: { status: "paused" } }).where).toBeDefined();
    expect(() =>
      encode({
        // @ts-expect-error — a tree clause is checked against the declaration too
        where: or({ column: "enabled", op: "eq", operand: "x" }),
      }),
    ).toThrow();
  });
});

describe("encode", () => {
  it("default query is byte-identical { limit: '100' }", () => {
    expect(encode()).toEqual({ limit: "100" });
    expect(encode({})).toEqual({ limit: "100" });
    expect(JSON.stringify(encode())).toBe('{"limit":"100"}');
  });

  it("explicit defaults — and an empty and() — encode to the same bytes", () => {
    const explicit = encode({
      where: {},
      orderBy: [["createdAt", "desc"]],
      limit: 100,
    });
    expect(JSON.stringify(explicit)).toBe(JSON.stringify(encode()));
    expect(encode({ where: and() })).toEqual({ limit: "100" });
  });

  it("canonicalizes key order, in lists and { eq }", () => {
    const a = encode({
      where: {
        status: { in: ["running", "error", "running"] },
        enabled: { eq: true },
      },
    });
    const b = encode({
      where: { enabled: true, status: { in: ["error", "running"] } },
    });
    expect(a).toEqual(b);
    expect(a).toEqual({
      limit: "100",
      where:
        '{"and":[{"column":"enabled","op":"eq","operand":true},' +
        '{"column":"status","op":"in","operand":["error","running"]}]}',
    });
  });

  it("the object sugar and the equivalent tree encode to the same bytes", () => {
    const sugar = encode({
      where: { enabled: true, status: { in: ["error", "running"] } },
    });
    const tree = encode({
      where: and(
        { column: "status", op: "in", operand: ["running", "error"] },
        and({ column: "enabled", op: "eq", operand: true }),
      ),
    });
    expect(tree).toEqual(sugar);
  });

  it("an or tree encodes canonically", () => {
    const a = encode({
      where: or(
        { column: "status", op: "eq", operand: "error" },
        and(
          { column: "enabled", op: "eq", operand: false },
          { column: "name", op: "gte", operand: "m" },
        ),
      ),
    });
    const b = encode({
      where: or(
        and(
          { column: "name", op: "gte", operand: "m" },
          { column: "enabled", op: "eq", operand: false },
        ),
        { column: "status", op: "eq", operand: "error" },
      ),
    });
    expect(a).toEqual(b);
    expect(a.where).toBe(
      '{"or":[{"and":[{"column":"enabled","op":"eq","operand":false},' +
        '{"column":"name","op":"gte","operand":"m"}]},' +
        '{"column":"status","op":"eq","operand":"error"}]}',
    );
  });

  it("sorts and dedupes lists", () => {
    expect(
      encode({ where: { name: { notIn: ["b", "a", "b", "A"] } } }).where,
    ).toBe('{"column":"name","op":"notIn","operand":["A","a","b"]}');
  });

  it("spells a no-operand op { op: true }", () => {
    expect(encode({ where: { name: { isEmpty: true } } }).where).toBe(
      '{"column":"name","op":"isEmpty"}',
    );
    expect(() =>
      // @ts-expect-error — only `true` spells a no-operand op
      encode({ where: { name: { isEmpty: false } } }),
    ).toThrow(/isEmpty: true/);
  });

  it("drops undefined filters (an absent optional key)", () => {
    expect(encode({ where: { status: undefined, enabled: false } })).toEqual({
      limit: "100",
      where: '{"column":"enabled","op":"eq","operand":false}',
    });
  });

  it("emits order only when it differs from the default", () => {
    expect(encode({ orderBy: [["name", "asc"]], limit: 50 })).toEqual({
      limit: "50",
      order: '[["name","asc"]]',
    });
  });

  it("throws above maxLimit and on non-positive limits (never clamps)", () => {
    expect(() => encode({ limit: 501 })).toThrow(/exceeds maxLimit/);
    expect(() => encode({ limit: 0 })).toThrow(/positive integer/);
    expect(() => encode({ limit: 1.5 })).toThrow(/positive integer/);
  });

  it("rejects null operands and over-long lists", () => {
    // @ts-expect-error — operands are never null
    expect(() => encode({ where: { name: null } })).toThrow(/isEmpty/);
    expect(() =>
      encode({
        where: {
          name: { in: Array.from({ length: 101 }, (_, i) => `n${i}`) },
        },
      }),
    ).toThrow(/exceeds 100/);
  });
});

type Query = NonNullable<Parameters<typeof encode>[0]>;

describe("decode", () => {
  const roundTrip: Query[] = [
    {},
    { limit: 20 },
    { where: { enabled: true } },
    {
      where: {
        status: { in: ["error", "running"] },
        name: { gte: "m" },
      },
    },
    { where: { name: { isEmpty: true } } },
    {
      where: or(
        { column: "enabled", op: "eq", operand: true },
        { column: "name", op: "contains", operand: "x" },
      ),
    },
    {
      where: { status: { ne: "idle" } },
      orderBy: [
        ["name", "asc"],
        ["createdAt", "desc"],
      ] as const,
      limit: 500,
    },
  ];

  it("decode(encode(q)) round-trips", () => {
    for (const q of roundTrip) {
      const params = encode(q);
      const decoded = decode(params);
      expect(
        encode({
          limit: decoded.limit,
          orderBy: decoded.orderBy,
          where: decoded.where as Query["where"],
        }),
      ).toEqual(params);
    }
  });

  it("fills defaults and yields the canonical tree", () => {
    expect(
      decode({
        limit: "100",
        where: '{"column":"enabled","op":"eq","operand":true}',
      }),
    ).toEqual({
      limit: 100,
      where: { column: "enabled", op: "eq", operand: true },
      orderBy: [["createdAt", "desc"]],
    });
    expect(decode({ limit: "100" }).where).toBeUndefined();
  });

  it("rejects unknown columns, ops, operands and params", () => {
    const w = (where: string) => ({ limit: "100", where });
    expect(() => decode(w('{"column":"id","op":"eq","operand":"x"}'))).toThrow(
      /not a filterable column/,
    );
    expect(() =>
      decode(w('{"column":"name","op":"like","operand":"x"}')),
    ).toThrow(/unknown op/);
    expect(() =>
      decode(w('{"column":"enabled","op":"gt","operand":true}')),
    ).toThrow(/does not take a boolean column/);
    expect(() =>
      decode(w('{"column":"name","op":"in","operand":"x"}')),
    ).toThrow(/takes a list/);
    expect(() =>
      decode(w('{"column":"name","op":"isEmpty","operand":1}')),
    ).toThrow(/takes no operand/);
    expect(() => decode(w("not json"))).toThrow(/invalid JSON/);
    expect(() => decode(w("[]"))).toThrow(/and\/or group/);
    expect(() => decode({ limit: "100", cursor: "x" })).toThrow(
      /unknown param/,
    );
    expect(() => decode({ limit: "100", order: '[["id","asc"]]' })).toThrow(
      /not a sortable/,
    );
  });

  it("a stale enum operand decodes (checked against the domain) and matches nothing", () => {
    const params = {
      limit: "100",
      where: '{"column":"status","op":"eq","operand":"paused"}',
    };
    const { where } = decode(params);
    expect(where).toEqual({ column: "status", op: "eq", operand: "paused" });
    const row = {
      id: "a",
      name: "a",
      status: "running",
      enabled: true,
      count: 1,
      createdAt: "2026-09-01T00:00:00.000Z",
    };
    for (const status of STATUSES) {
      expect(
        matchesFilter({ ...row, status }, where!, sources.filterable),
      ).toBe(false);
    }
  });

  it("rejects limits above max or malformed", () => {
    expect(() => decode({ limit: "501" })).toThrow(/exceeds maxLimit/);
    expect(() => decode({ limit: "010" })).toThrow(/canonical/);
    expect(() => decode({})).toThrow(/canonical/);
  });

  it("rejects every non-canonical spelling", () => {
    const nonCanonical: Record<string, string>[] = [
      // an unsorted / duplicated list
      {
        limit: "100",
        where: '{"column":"status","op":"in","operand":["running","error"]}',
      },
      {
        limit: "100",
        where: '{"column":"status","op":"in","operand":["error","error"]}',
      },
      // a singleton group
      {
        limit: "100",
        where: '{"and":[{"column":"enabled","op":"eq","operand":true}]}',
      },
      // unsorted children
      {
        limit: "100",
        where:
          '{"and":[{"column":"status","op":"eq","operand":"idle"},{"column":"enabled","op":"eq","operand":true}]}',
      },
      // key order / whitespace
      {
        limit: "100",
        where: '{"op":"eq","column":"enabled","operand":true}',
      },
      {
        limit: "100",
        where: '{ "column":"enabled","op":"eq","operand":true}',
      },
      { limit: "100", order: '[["createdAt","desc"]]' },
    ];
    for (const params of nonCanonical) {
      expect(() => decode(params)).toThrow(/canonical/);
    }
    // The absent filter has no encoding — its param is omitted.
    expect(() => decode({ limit: "100", where: '{"and":[]}' })).toThrow(
      /absent filter/,
    );
  });

  it("decode's filter is exactly the filter language's strict decode", () => {
    const json = encode({
      where: or(
        { column: "enabled", op: "eq", operand: true },
        { column: "name", op: "lt", operand: "m" },
      ),
    }).where!;
    expect(decode({ limit: "100", where: json }).where).toEqual(
      decodeFilter(json, sources.filterable),
    );
  });
});

describe("preload", () => {
  const spec = {
    ...F,
    sortable: ["name"],
    default: { orderBy: [["name", "asc"]], limit: 10 },
    maxLimit: 20,
  } as const;

  it('is off by default, and "none" sets nothing', () => {
    const c = liveCollection("live-test.preload-none", spec);
    expect(c.window.preload).toBeUndefined();
    const n = liveCollection("live-test.preload-none-explicit", {
      ...spec,
      preload: "none",
    });
    expect(n.window.preload).toBeUndefined();
  });

  it('"boot" marks the window only — never :rows or :groups', () => {
    const c = liveCollection("live-test.preload-boot", {
      ...spec,
      preload: "boot",
    });
    expect(c.window.preload).toBe("boot");
    expect(c.window.defaultParams).toEqual({ limit: "10" });
    expect(c.rows.preload).toBeUndefined();
    expect(c.groups.preload).toBeUndefined();
  });

  it('"boot-and-keep" is forwarded as is, to the window only', () => {
    const c = liveCollection("live-test.preload-keep", {
      ...spec,
      preload: "boot-and-keep",
    });
    expect(c.window.preload).toBe("boot-and-keep");
    expect(c.rows.preload).toBeUndefined();
  });
});

describe("groups codec", () => {
  const groups = sources.groups.groups;

  it("encodes groupBy + the default limit, where only when non-empty", () => {
    expect(groups.defaultLimit).toBe(50);
    expect(groups.maxLimit).toBe(100);
    expect(groups.encode({ groupBy: "status" })).toEqual({
      groupBy: "status",
      limit: "50",
    });
    expect(groups.encode({ groupBy: "status", where: {} })).toEqual({
      groupBy: "status",
      limit: "50",
    });
  });

  it("canonicalises where exactly as a window does", () => {
    const a = groups.encode({
      groupBy: "status",
      where: { enabled: { eq: true }, name: { in: ["b", "a", "b"] } },
      limit: 20,
    });
    const b = groups.encode({
      groupBy: "status",
      where: or(
        and(
          { column: "name", op: "in", operand: ["a", "b"] },
          { column: "enabled", op: "eq", operand: true },
        ),
      ),
      limit: 20,
    });
    expect(a).toEqual(b);
    expect(a).toEqual({
      groupBy: "status",
      limit: "20",
      where:
        '{"and":[{"column":"enabled","op":"eq","operand":true},' +
        '{"column":"name","op":"in","operand":["a","b"]}]}',
    });
    expect(a.where).toBe(
      encode({ where: { enabled: true, name: { in: ["a", "b"] } } }).where,
    );
  });

  it("round-trips through a strict decode", () => {
    const params = groups.encode({
      groupBy: "enabled",
      where: { status: { ne: "idle" } },
    });
    expect(groups.decode(params)).toEqual({
      groupBy: "enabled",
      limit: 50,
      where: { column: "status", op: "ne", operand: "idle" },
    });
  });

  it("throws on an undeclared or ungroupable column, a limit above max, and an orderBy", () => {
    // @ts-expect-error — "id" is not filterable, so it cannot be grouped on
    expect(() => groups.encode({ groupBy: "id" })).toThrow(
      /not a filterable column/,
    );
    expect(() => groups.encode({ groupBy: "status", limit: 101 })).toThrow(
      /exceeds 100/,
    );
    expect(() => groups.encode({ groupBy: "status", limit: 0 })).toThrow(
      /positive integer/,
    );
    expect(() =>
      groups.encode({
        groupBy: "status",
        // @ts-expect-error — a grouping has a fixed order
        orderBy: [["name", "asc"]],
      }),
    ).toThrow(/fixed order/);
  });

  it("decode rejects undeclared columns, bad limits, unknown params and non-canonical spellings", () => {
    expect(() => groups.decode({ groupBy: "id", limit: "50" })).toThrow(
      /not a filterable column/,
    );
    expect(() => groups.decode({ groupBy: "status", limit: "101" })).toThrow(
      /exceeds 100/,
    );
    expect(() => groups.decode({ groupBy: "status", limit: "050" })).toThrow(
      /canonical/,
    );
    expect(() => groups.decode({ groupBy: "status" })).toThrow(/canonical/);
    expect(() =>
      groups.decode({
        groupBy: "status",
        limit: "50",
        order: '[["name","asc"]]',
      }),
    ).toThrow(/unknown param "order"/);
    expect(() =>
      groups.decode({ groupBy: "status", limit: "50", where: '{"and":[]}' }),
    ).toThrow(/absent filter/);
    expect(() =>
      groups.decode({
        groupBy: "status",
        limit: "50",
        where: '{"and":[{"column":"enabled","op":"eq","operand":true}]}',
      }),
    ).toThrow(/not canonical/);
  });
});

describe("count codec", () => {
  const counted = liveCollection("live-test.codec-counted", {
    ...F,
    sortable: ["createdAt"],
    default: { orderBy: [["createdAt", "desc"]], limit: 100 },
    maxLimit: 500,
    count: true,
    preload: "boot",
  });

  it("is minted only when declared, and preloads with the window", () => {
    expect(sources.count).toBeNull();
    expect(counted.count.key).toBe("live-test.codec-counted:count");
    expect(counted.count.preload).toBe("boot");
  });

  it("the whole collection is the param-less tuple; where as a window encodes it", () => {
    const codec = counted.count.count;
    expect(codec.encode({})).toEqual({});
    expect(codec.encode({ where: {} })).toEqual({});
    const params = codec.encode({ where: { enabled: true } });
    expect(params).toEqual({
      where: counted.window.window.encode({ where: { enabled: true } }).where,
    });
    expect(codec.decode(params).where).toEqual(
      decodeFilter(params.where!, counted.filterable),
    );
    expect(codec.decode({}).where).toBeUndefined();
  });

  it("refuses a non-canonical or foreign param as a contract mismatch", () => {
    const codec = counted.count.count;
    expect(() => codec.decode({ limit: "1" })).toThrow(ResourceContractError);
    expect(() => codec.decode({ where: "{}" })).toThrow(ResourceContractError);
    expect(() =>
      codec.encode({ groupBy: "status" } as unknown as { where?: object }),
    ).toThrow(/takes a `where` only/);
  });

  it("is refused beside `arms` (an untyped caller)", () => {
    expect(() =>
      liveCollection("live-test.codec-counted-union", {
        ...F,
        sortable: ["createdAt"],
        default: { orderBy: [["createdAt", "desc"]], limit: 100 },
        maxLimit: 500,
        arms: { discriminator: "status" },
        count: true,
      } as never),
    ).toThrow(/count beside `arms`/);
  });
});

describe("which failures are a contract mismatch", () => {
  // A DECODE failure is a subscription whose params do not match the
  // declaration (the runtime refuses it as `contract-mismatch`); a declaration
  // or an encode failure is a programmer error and stays a plain Error.
  const isContract = (fn: () => unknown): boolean => {
    try {
      fn();
    } catch (err) {
      return err instanceof ResourceContractError;
    }
    throw new Error("expected a throw");
  };

  it("decode, decodeGroups and the gates throw ResourceContractError", () => {
    expect(isContract(() => decode({}))).toBe(true);
    expect(isContract(() => decode({ limit: "100", cursor: "x" }))).toBe(true);
    expect(isContract(() => decode({ limit: "9999" }))).toBe(true);
    expect(isContract(() => decode({ limit: "100", where: "not json" }))).toBe(
      true,
    );
    expect(isContract(() => decode({ limit: "100", order: "nope" }))).toBe(
      true,
    );
    expect(
      isContract(() => decode({ limit: "100", order: '[["id","asc"]]' })),
    ).toBe(true);
    expect(isContract(() => sources.groups.groups.decode({}))).toBe(true);
    expect(
      isContract(() =>
        sources.groups.groups.decode({ groupBy: "id", limit: "5" }),
      ),
    ).toBe(true);
    // The incident: a pre-deploy bundle subscribing the window with `{}`.
    expect(isContract(() => sources.window.validateParams({}))).toBe(true);
    expect(isContract(() => sources.groups.validateParams({}))).toBe(true);
    expect(isContract(() => sources.rows.validateParams({}))).toBe(true);
    expect(
      isContract(() => sources.rows.validateParams({ ids: "a", x: "1" })),
    ).toBe(true);
  });

  it("the gates accept every canonical encoding", () => {
    expect(() =>
      sources.window.validateParams(
        encode({ limit: 5, where: { enabled: true } }),
      ),
    ).not.toThrow();
    expect(() =>
      sources.groups.validateParams(
        sources.groups.groups.encode({ groupBy: "status" }),
      ),
    ).not.toThrow();
    expect(() =>
      sources.rows.validateParams(sources.rows.point.encode(["a", "b"])),
    ).not.toThrow();
  });

  it("encode and declaration failures stay plain Errors", () => {
    expect(isContract(() => encode({ limit: 0 }))).toBe(false);
    expect(
      isContract(() =>
        liveCollection("live-test.contract-decl", {
          ...F,
          sortable: ["name"],
          default: { orderBy: [["name", "asc"]], limit: 0 },
          maxLimit: 1,
        }),
      ),
    ).toBe(false);
  });
});

describe("page cuts — every window takes them", () => {
  const scrolled = liveCollection("live-test.codec-scroll", {
    ...F,
    sortable: ["createdAt", "name", "id"],
    default: { orderBy: [["createdAt", "desc"]], limit: 100 },
    maxLimit: 300,
  });
  const codec = scrolled.window.window;
  // A row key of the default order: createdAt's text, then the id.
  const cut = JSON.stringify(["2026-09-30 10:00:00.123456+00", "r1"]);

  it("needs maxLimit ≥ 2 · default.limit, on every window", () => {
    expect(() =>
      liveCollection("live-test.codec-scroll-tight", {
        ...F,
        sortable: ["name"],
        default: { orderBy: [["name", "asc"]], limit: 100 },
        maxLimit: 199,
      }),
    ).toThrow(/maxLimit must be ≥ 2 · default.limit \(200\), got 199/);
  });

  it("cuts are absent by default: the default tuple stays byte-identical", () => {
    expect(codec.encode()).toEqual({ limit: "100" });
    expect(codec.encode({}, {})).toEqual({ limit: "100" });
    expect(scrolled.window.defaultParams).toEqual({ limit: "100" });
  });

  it("encodes each cut verbatim and round-trips it through the strict decode", () => {
    const params = codec.encode({ limit: 200 }, { after: cut, until: cut });
    expect(params).toEqual({ limit: "200", after: cut, until: cut });
    const decoded = codec.decode(params);
    expect(decoded.after).toEqual(["2026-09-30 10:00:00.123456+00", "r1"]);
    expect(decoded.until).toEqual(["2026-09-30 10:00:00.123456+00", "r1"]);
    // NULL order keys are part of a key; the id never is NULL.
    const nullKey = JSON.stringify([null, "r2"]);
    expect(codec.decode({ limit: "100", after: nullKey }).after).toEqual([
      null,
      "r2",
    ]);
  });

  it("decode is strict on arity: exactly the order's keys, then the id — unless the order names it", () => {
    expect(() => codec.decode({ limit: "100", after: '["x"]' })).toThrow(
      /row key of 2 text values/,
    );
    expect(() =>
      codec.decode({ limit: "100", after: '["x","y","z"]' }),
    ).toThrow(/row key of 2 text values/);
    // Two order keys + the id.
    const two = codec.encode(
      {
        orderBy: [
          ["name", "asc"],
          ["createdAt", "desc"],
        ],
      },
      { until: '["a","b","r1"]' },
    );
    expect(codec.decode(two).until).toEqual(["a", "b", "r1"]);
    expect(() => codec.decode({ ...two, until: '["a","r1"]' })).toThrow(
      /row key of 3 text values/,
    );
    // The order already ends with the id: no second copy of it.
    const byId = codec.encode(
      {
        orderBy: [
          ["name", "asc"],
          ["id", "asc"],
        ],
      },
      { after: '["a","r1"]' },
    );
    expect(codec.decode(byId).after).toEqual(["a", "r1"]);
  });

  it("decode rejects a NULL id, a non-text value and a non-canonical spelling", () => {
    expect(() => codec.decode({ limit: "100", after: '["x",null]' })).toThrow(
      /row key/,
    );
    expect(() => codec.decode({ limit: "100", after: '["x",1]' })).toThrow(
      /row key/,
    );
    expect(() => codec.decode({ limit: "100", after: '["x", "r1"]' })).toThrow(
      /not canonical/,
    );
    expect(() => codec.decode({ limit: "100", after: "not json" })).toThrow(
      /invalid JSON/,
    );
    // A cut that fails to decode is a contract mismatch, like any other param.
    expect(() => codec.decode({ limit: "100", after: '["x",1]' })).toThrow(
      ResourceContractError,
    );
  });

  it("encode throws where a bad cut was built", () => {
    expect(() => codec.encode(undefined, { after: '["only"]' })).toThrow(
      /row key of 2 text values/,
    );
  });
});
