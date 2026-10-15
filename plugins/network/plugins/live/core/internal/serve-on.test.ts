/**
 * The one serving code path (`serve-on.ts`) on a real `createResourceRuntime`
 * through the resource runtime's harness (a fake socket recording every
 * frame): an external collection's window, `:rows` and `all` subscribe and
 * ship keyed deltas on `notify`; every answer is checked against the row
 * schema; a silent collection has no `notify`; every window's rows carry a
 * minted `$key`. And `serveValueOn` per host mode: a `"db+external"` host
 * serves a db value, an `"external"` one refuses it (a cast past the types).
 */

import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { fieldsToZodObject } from "@plugins/fields/core";
import { intField } from "@plugins/fields/plugins/int/plugins/config/core";
import { textField } from "@plugins/fields/plugins/text/plugins/config/core";
import { createHarness } from "@plugins/framework/plugins/resource-runtime/core/testing";
import { liveCollection } from "./live-collection";
import { liveValue } from "./live-value";
import { serveCollectionOn, serveValueOn } from "./serve-on";

const LISTED = { title: textField({ label: "Title" }) };
const CARRIED = { id: textField(), rank: intField() };
const F = { fields: LISTED, carry: { fields: CARRIED }, id: "id" } as const;
const RowSchema = fieldsToZodObject({ ...LISTED, ...CARRIED });
type Row = z.infer<typeof RowSchema>;

let seq = 0;
const key = (name: string) => `test.serve-on.${name}.${seq++}`;

/**
 * Await `p` and return the Error it rejected with; throw if it resolved.
 * (`expect(p).rejects.toThrow()` is typed `void` under bun:test.)
 */
async function rejection(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (err) {
    return err as Error;
  }
  throw new Error("expected the promise to reject, but it resolved");
}

const settle = async (h: ReturnType<typeof createHarness>) => {
  for (let i = 0; i < 5; i++) await h.tick();
};

/** An in-memory source: rows by id, read in rank order. */
function source(initial: Row[]) {
  const rows = new Map(initial.map((r) => [r.id, r]));
  const loads: string[] = [];
  const ordered = () => [...rows.values()].sort((a, b) => a.rank - b.rank);
  return {
    rows,
    loads,
    window: (limit: number) => {
      loads.push(`window:${limit}`);
      return ordered().slice(0, limit);
    },
    byIds: (ids: readonly string[]) => {
      loads.push(`rows:${ids.join(",")}`);
      return ids.flatMap((id) => {
        const r = rows.get(id);
        return r === undefined ? [] : [r];
      });
    },
    all: () => {
      loads.push("all");
      return ordered();
    },
  };
}

const windowCollection = (k: string) =>
  liveCollection(k, {
    ...F,
    sortable: ["rank", "title"],
    default: { orderBy: [["rank", "asc"]], limit: 10 },
    maxLimit: 50,
  });

/** `rank` is a number: its `$key` text, zero-padded so text order is its order. */
const keyText = { rank: (n: number) => String(n).padStart(4, "0") };

/** A row as a rank-ordered window ships it: with its minted `$key`. */
const keyed = (r: Row) => ({
  ...r,
  $key: JSON.stringify([keyText.rank(r.rank), r.id]),
});

const initial: Row[] = [
  { id: "a", title: "A", rank: 1 },
  { id: "b", title: "B", rank: 2 },
  { id: "c", title: "C", rank: 3 },
];

describe("serveCollectionOn — a window collection", () => {
  test("the window subscribes and a notify ships a keyed delta", async () => {
    const h = createHarness();
    const c = windowCollection(key("window"));
    const src = source(initial);
    const served = serveCollectionOn(h.runtime, c, {
      source: "external",
      changes: "notified",
      keyText,
      window: (q) => src.window(q.limit),
      rows: (ids) => src.byIds(ids),
    });
    expect(served.keys).toEqual([c.rows.key, c.key]);
    expect(served.groups).toBeNull();
    expect(served.count).toBeNull();

    await h.subscribe(c.key, c.window.defaultParams);
    const ack = h.frames.find((f) => f.kind === "sub-ack" && f.key === c.key);
    expect(ack?.value).toEqual(initial.map(keyed));

    src.rows.set("b", { id: "b", title: "B2", rank: 2 });
    served.notify();
    await settle(h);
    const pushes = h.pushesFor(c.key);
    expect(pushes.map((f) => f.kind)).toEqual(["delta"]);
    expect(pushes[0]!.upserts).toEqual([
      ["b", keyed({ id: "b", title: "B2", rank: 2 })],
    ]);
  });

  test(":rows subscribes, and notify({ ids }) re-reads only the tuples holding one", async () => {
    const h = createHarness();
    const c = windowCollection(key("rows"));
    const src = source(initial);
    const served = serveCollectionOn(h.runtime, c, {
      source: "external",
      changes: "notified",
      keyText,
      window: (q) => src.window(q.limit),
      rows: (ids) => src.byIds(ids),
    });
    await h.subscribe(c.rows.key, c.rows.point.encode(["a", "b"]));
    await h.subscribe(c.rows.key, c.rows.point.encode(["c"]));
    const ack = h.frames.find(
      (f) => f.kind === "sub-ack" && f.key === c.rows.key,
    );
    expect(ack?.value).toEqual([initial[0], initial[1]]);

    src.rows.set("a", { id: "a", title: "A2", rank: 1 });
    const at = src.loads.length;
    served.notify({ ids: ["a"] });
    await settle(h);
    // Only the tuple whose id set holds "a" re-read.
    expect(src.loads.slice(at)).toEqual(["rows:a,b"]);
    const pushes = h.pushesFor(c.rows.key);
    expect(pushes.map((f) => f.kind)).toEqual(["delta"]);
    expect(pushes[0]!.params).toEqual({ ids: "a,b" });
    expect(pushes[0]!.upserts).toEqual([
      ["a", { id: "a", title: "A2", rank: 1 }],
    ]);

    // A row it did not ask for is the source's bug.
    const bad = serveCollectionOn(
      createHarness().runtime,
      windowCollection(key("rows-bad")),
      {
        source: "external",
        changes: "notified",
        keyText,
        window: () => [],
        rows: () => [initial[2]!],
      },
    );
    expect((await rejection(bad.rows.load({ ids: "a" }))).message).toMatch(
      /rows\(ids\) returned the id "c", which was not asked for/,
    );
  });

  test("groups and a declared count are served through their own answers, checked", async () => {
    const h = createHarness();
    const k = key("groups");
    const c = liveCollection(k, {
      ...F,
      sortable: ["rank"],
      default: { orderBy: [["rank", "asc"]], limit: 10 },
      maxLimit: 50,
      count: true,
    });
    const served = serveCollectionOn(h.runtime, c, {
      source: "external",
      changes: { fixed: { reason: "a test fixture" } },
      keyText,
      window: () => initial,
      rows: () => [],
      groups: () => [
        { value: "A", count: 2 },
        { value: null, count: 1 },
      ],
      count: () => 3,
    });
    expect(served.keys).toEqual([
      c.rows.key,
      c.key,
      `${k}:groups`,
      `${k}:count`,
    ]);
    const groupParams = c.groups.groups.encode({ groupBy: "title" });
    expect(await served.groups!.load(groupParams)).toEqual([
      { value: "A", count: 2 },
      { value: null, count: 1 },
    ]);
    expect(await served.count!.load({})).toBe(3);
    // Never called — the assertions are the `@ts-expect-error`s.
    const typesOnly = () => {
      // @ts-expect-error — declared `count: true`: `count(q)` is required
      serveCollectionOn(h.runtime, c, {
        source: "external",
        changes: "notified",
        keyText,
        window: () => initial,
        rows: () => [],
      });
      // @ts-expect-error — not declared `count: true`: no `count`
      serveCollectionOn(h.runtime, windowCollection(key("t")), {
        source: "external",
        changes: "notified",
        keyText,
        window: () => initial,
        rows: () => [],
        count: () => 0,
      });
    };
    expect(typeof typesOnly).toBe("function");
  });

  test("an answer that breaks the row schema fails loudly, naming the key and the field", async () => {
    const h = createHarness();
    const k = key("schema");
    const c = windowCollection(k);
    const served = serveCollectionOn(h.runtime, c, {
      source: "external",
      changes: "notified",
      keyText,
      window: () => [{ id: "a", title: 5, rank: 1 } as unknown as Row],
      rows: () => [],
    });
    expect(
      (await rejection(served.window.load(c.window.defaultParams))).message,
    ).toContain(`serveCollection("${k}"): window(q) row 0: field "title"`);
    // An answer past the limit asked, and an id twice, fail the same way.
    const over = serveCollectionOn(h.runtime, windowCollection(key("over")), {
      source: "external",
      changes: "notified",
      keyText,
      window: () => initial,
      rows: () => [],
    });
    expect((await rejection(over.window.load({ limit: "2" }))).message).toMatch(
      /returned 3 rows for at most 2/,
    );
    const twice = serveCollectionOn(h.runtime, windowCollection(key("twice")), {
      source: "external",
      changes: "notified",
      keyText,
      window: () => [initial[0]!, initial[0]!],
      rows: () => [],
    });
    expect(
      (await rejection(twice.window.load({ limit: "10" }))).message,
    ).toMatch(/returned the id "a" twice/);
  });

  test("a silent collection has no notify — in its type, and at runtime", () => {
    const h = createHarness();
    const fixed = serveCollectionOn(h.runtime, windowCollection(key("fixed")), {
      source: "external",
      changes: { fixed: { reason: "a demo pack" } },
      keyText,
      window: () => initial,
      rows: () => [],
    });
    expect("notify" in fixed).toBe(false);
    expect(fixed.changes).toEqual({ fixed: { reason: "a demo pack" } });
    const immutable = serveCollectionOn(
      h.runtime,
      liveCollection(key("immutable-lookup"), { ...F }),
      {
        source: "external",
        changes: { immutable: { reason: "sha-keyed" } },
        rows: () => [],
      },
    );
    expect("notify" in immutable).toBe(false);
    const typesOnly = () => {
      // @ts-expect-error — a fixed collection is never told of a change
      fixed.notify();
    };
    expect(typeof typesOnly).toBe("function");
    // An empty reason, and a snapshot, throw for an untyped caller.
    expect(() =>
      serveCollectionOn(h.runtime, windowCollection(key("empty")), {
        source: "external",
        changes: { fixed: { reason: " " } },
        keyText,
        window: () => [],
        rows: () => [],
      }),
    ).toThrow(/`changes.fixed.reason` is empty/);
    expect(() =>
      serveCollectionOn(h.runtime, windowCollection(key("snap")), {
        source: "external",
        changes: { snapshot: { reason: "x" } } as never,
        keyText,
        window: () => [],
        rows: () => [],
      }),
    ).toThrow(/never a snapshot/);
  });
});

describe("serveCollectionOn — every window's $key", () => {
  test("rows carry a minted $key; a non-text order field needs keyText", async () => {
    const h = createHarness();
    const c = liveCollection(key("keyed"), {
      ...F,
      sortable: ["rank", "title"],
      default: { orderBy: [["rank", "desc"]], limit: 10 },
      maxLimit: 50,
    });
    const desc = [...initial].reverse();
    const served = serveCollectionOn(h.runtime, c, {
      source: "external",
      changes: "notified",
      keyText,
      window: () => desc,
      rows: () => [],
    });
    const rows = (await served.window.load(c.window.defaultParams)) as (Row & {
      $key: string | null;
    })[];
    expect(rows.map((r) => r.$key)).toEqual([
      JSON.stringify(["0003", "c"]),
      JSON.stringify(["0002", "b"]),
      JSON.stringify(["0001", "a"]),
    ]);
    // A cut: the rows past `after`, checked against it.
    const after = c.window.window.encode(undefined, {
      after: JSON.stringify(["0002", "b"]),
    });
    expect((await rejection(served.window.load(after))).message).toMatch(
      /window\(q\): item .* is outside the range asked/,
    );
    const typesOnly = () => {
      // @ts-expect-error — `rank` is a number: its `$key` text must be given
      serveCollectionOn(h.runtime, c, {
        source: "external",
        changes: "notified",
        window: () => desc,
        rows: () => [],
      });
    };
    expect(typeof typesOnly).toBe("function");
  });

  test("rows answered out of the order asked are refused", async () => {
    const h = createHarness();
    const c = liveCollection(key("key-order"), {
      ...F,
      sortable: ["title"],
      default: { orderBy: [["title", "asc"]], limit: 10 },
      maxLimit: 50,
    });
    const served = serveCollectionOn(h.runtime, c, {
      source: "external",
      changes: "notified",
      window: () => [initial[1]!, initial[0]!],
      rows: () => [],
    });
    expect(
      (await rejection(served.window.load(c.window.defaultParams))).message,
    ).toMatch(/not in strictly ascending key order/);
  });
});

describe("serveCollectionOn — an `all` collection", () => {
  test("pushes the whole set, and a notify ships a keyed delta", async () => {
    const h = createHarness();
    const c = liveCollection(key("all"), {
      ...F,
      all: { orderBy: [["rank", "asc"]], unbounded: { reason: "a test set" } },
    });
    const src = source(initial);
    const served = serveCollectionOn(h.runtime, c, {
      source: "external",
      changes: "notified",
      all: () => src.all(),
      rows: (ids) => src.byIds(ids),
    });
    expect(served.keys).toEqual([c.rows.key, c.key]);
    await h.subscribe(c.key, {});
    const ack = h.frames.find((f) => f.kind === "sub-ack" && f.key === c.key);
    expect(ack?.value).toEqual(initial);

    src.rows.delete("a");
    served.notify();
    await settle(h);
    const pushes = h.pushesFor(c.key);
    expect(pushes.map((f) => f.kind)).toEqual(["delta"]);
    expect(pushes[0]!.deletes).toEqual(["a"]);
  });
});

describe("serveValueOn — per host mode", () => {
  const Count = z.object({ n: z.number() });

  test('a "db+external" host serves a db value (no notify)', async () => {
    const h = createHarness();
    const v = liveValue(key("db"), { schema: Count });
    const served = serveValueOn(
      h.runtime,
      v,
      { source: "db", loader: () => ({ n: 1 }) },
      { sources: "db+external" },
    );
    expect(served.source).toBe("db");
    expect("notify" in served).toBe(false);
    expect(await served.load({})).toEqual({ n: 1 });
  });

  test('an "external" host refuses a db value (a cast past the types)', () => {
    const h = createHarness();
    const v = liveValue(key("refused"), { schema: Count });
    expect(() =>
      serveValueOn(
        h.runtime,
        v,
        { source: "db", loader: () => ({ n: 1 }) } as never,
        { sources: "external" },
      ),
    ).toThrow(/this host serves only `source: "external"`/);
    // …and serves an external one, notified.
    const served = serveValueOn(
      h.runtime,
      liveValue(key("ext"), { schema: Count }),
      { source: "external", changes: "notified", loader: () => ({ n: 2 }) },
      { sources: "external" },
    );
    expect(typeof served.notify).toBe("function");
  });
});
