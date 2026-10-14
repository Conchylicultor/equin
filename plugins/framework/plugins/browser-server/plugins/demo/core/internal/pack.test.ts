/**
 * A demo pack served by a real `createBrowserServer`, read over its HTTP
 * resource route with tuples spelled by the declarations' own codecs (the
 * ones `useLive` encodes with): each builder answers its exact tuple; a
 * window answers any limit (the first rows, in the query's order) and a
 * page cut; `:rows` answers any id subset; `:count` the recorded total; an
 * unrecorded tuple throws `DemoMissingError` (read as `loader-failed`); a
 * schema mismatch throws `DemoPackError` naming the key, while the pack loads;
 * `ago` counts back from load time.
 */

import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { createBrowserServer } from "@plugins/framework/plugins/browser-server/core";
import { liveCollection, liveValue } from "@plugins/network/plugins/live/core";
import { liveText } from "@plugins/network/plugins/live/plugins/filter/core";
import {
  definePack,
  DemoMissingError,
  DemoPackError,
  packAll,
  packRows,
  packValue,
  packWindow,
  servePack,
  type DemoPack,
} from "./pack";

let seq = 0;
const key = (name: string) => `test.demo-pack.${name}.${seq++}`;

const Item = z.object({
  id: z.string(),
  title: z.string(),
  kind: z.enum(["a", "b"]),
  rank: z.number(),
  at: z.string(),
});
type Item = z.infer<typeof Item>;

const items = liveCollection(key("items"), {
  row: Item,
  id: "id",
  filterable: { kind: liveText(z.enum(["a", "b"])) },
  sortable: ["rank", "title"],
  default: { orderBy: [["rank", "asc"]], limit: 2 },
  maxLimit: 10,
  count: true,
});
const tracks = liveCollection(key("tracks"), {
  row: Item,
  id: "id",
  all: {
    orderBy: [["rank", "desc"]],
    unbounded: { reason: "test fixture" },
  },
});
const byId = liveCollection(key("by-id"), { row: Item, id: "id" });
const greeting = liveValue(key("greeting"), {
  schema: z.object({ text: z.string() }),
  params: ["who", "lang?"],
});
const sum = liveValue(key("sum"), {
  schema: z.object({ total: z.number() }),
  query: z.object({ xs: z.array(z.number()), label: z.string().default("") }),
});
const unrecorded = liveValue(key("unrecorded"), {
  schema: z.object({ n: z.number() }),
});

const NOW = new Date("2026-10-14T12:00:00.000Z");

function item(id: string, rank: number, kind: "a" | "b", at = "x"): Item {
  return { id, title: id.toUpperCase(), kind, rank, at };
}
const A = [item("a1", 3, "a"), item("a2", 1, "a"), item("a3", 2, "a")];
const B = [item("b1", 5, "b"), item("b2", -0.5, "b")];

const pack = definePack(({ ago }) => [
  packValue(greeting, { who: "ada" }, { text: "hello ada" }),
  packValue(greeting, { who: "ada", lang: "fr" }, { text: "salut ada" }),
  packValue(sum, { xs: [1, 2] }, { total: 3 }),
  packWindow(items, {}, [...A, ...B]),
  packWindow(items, { where: { kind: "a" } }, A, { count: 7 }),
  packWindow(items, { where: { kind: "b" }, orderBy: [["title", "desc"]] }, B),
  packAll(tracks, [item("t1", 1, "a", ago(60_000)), item("t2", 2, "b")]),
  packRows(byId, [item("x1", 1, "a"), item("x2", 2, "b")]),
]);

function serverOf(p: DemoPack) {
  return createBrowserServer({
    serve: servePack(p, { now: NOW }),
    unserved: (k) => new DemoMissingError(k, {}),
    onError: () => {},
  });
}

/** One HTTP read of `key` at `params`: the value, or the failure's status and reason. */
async function read(
  server: ReturnType<typeof createBrowserServer>,
  resourceKey: string,
  params: Record<string, string>,
): Promise<
  { ok: true; value: unknown } | { ok: false; status: number; reason: string }
> {
  const url = new URL(
    `http://browser-server.invalid/api/resources/${encodeURIComponent(resourceKey)}`,
  );
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await server.request(new Request(url));
  const body = (await res.json()) as { value?: unknown; reason?: string };
  return res.ok
    ? { ok: true, value: body.value }
    : { ok: false, status: res.status, reason: body.reason ?? "?" };
}

const ids = (r: Awaited<ReturnType<typeof read>>) => {
  if (!r.ok) throw new Error(`read failed: ${r.status} ${r.reason}`);
  return (r.value as { id: string }[]).map((row) => row.id);
};
const window = (q: Parameters<typeof items.window.window.encode>[0] = {}) =>
  items.window.window.encode(q);

describe("servePack through a browser server", () => {
  test("a value answers its exact tuple — an absent optional param spelled any way — and a typed-query value its question", async () => {
    const server = serverOf(pack);
    expect(await read(server, greeting.key, { who: "ada" })).toEqual({
      ok: true,
      value: { text: "hello ada" },
    });
    // `?lang=` is the same tuple as no `lang` (canonical params).
    expect(await read(server, greeting.key, { who: "ada", lang: "" })).toEqual({
      ok: true,
      value: { text: "hello ada" },
    });
    expect(
      await read(server, greeting.key, { who: "ada", lang: "fr" }),
    ).toEqual({
      ok: true,
      value: { text: "salut ada" },
    });
    // The question as `useLive` encodes it (its default filled in).
    expect(
      await read(server, sum.key, sum.query.encode({ xs: [1, 2] })),
    ).toEqual({
      ok: true,
      value: { total: 3 },
    });
    server.dispose();
  });

  test("a window answers the first `limit` rows of its query, in the query's order, at any limit", async () => {
    const server = serverOf(pack);
    // The default window (limit 2, rank asc) — the tuple `useLive(items)` reads.
    expect(ids(await read(server, items.key, window()))).toEqual(["b2", "a2"]);
    expect(ids(await read(server, items.key, window({ limit: 10 })))).toEqual([
      "b2",
      "a2",
      "a3",
      "a1",
      "b1",
    ]);
    expect(
      ids(
        await read(
          server,
          items.key,
          window({ where: { kind: "a" }, limit: 5 }),
        ),
      ),
    ).toEqual(["a2", "a3", "a1"]);
    expect(
      ids(
        await read(
          server,
          items.key,
          window({ where: { kind: "b" }, orderBy: [["title", "desc"]] }),
        ),
      ),
    ).toEqual(["b2", "b1"]);
    server.dispose();
  });

  test("a window answers a page cut at a served row's `$key`", async () => {
    const server = serverOf(pack);
    const first = await read(server, items.key, window());
    if (!first.ok) throw new Error("first page failed");
    const rows = first.value as { id: string; $key: string }[];
    const cut = rows[rows.length - 1]!.$key;
    expect(
      ids(
        await read(
          server,
          items.key,
          items.window.window.encode({ limit: 2 }, { after: cut }),
        ),
      ),
    ).toEqual(["a3", "a1"]);
    expect(
      ids(
        await read(
          server,
          items.key,
          items.window.window.encode({ limit: 10 }, { until: cut }),
        ),
      ),
    ).toEqual(["b2", "a2"]);
    server.dispose();
  });

  test("`:count` answers each recorded `where` — given, or the rows listed", async () => {
    const server = serverOf(pack);
    const count = items.count!.count;
    expect(
      await read(
        server,
        items.count!.key,
        count.encode({ where: { kind: "a" } }),
      ),
    ).toEqual({
      ok: true,
      value: 7,
    });
    expect(await read(server, items.count!.key, count.encode({}))).toEqual({
      ok: true,
      value: 5,
    });
    server.dispose();
  });

  test("`:rows` answers any id subset from every row the declaration lists; `all` every row in its order", async () => {
    const server = serverOf(pack);
    expect(
      ids(
        await read(
          server,
          items.rows.key,
          items.rows.point.encode(["b1", "a2", "zz"]),
        ),
      ).sort(),
    ).toEqual(["a2", "b1"]);
    expect(
      ids(await read(server, byId.rows.key, byId.rows.point.encode(["x2"]))),
    ).toEqual(["x2"]);
    expect(ids(await read(server, tracks.key, {}))).toEqual(["t2", "t1"]);
    expect(
      ids(
        await read(server, tracks.rows.key, tracks.rows.point.encode(["t1"])),
      ),
    ).toEqual(["t1"]);
    server.dispose();
  });

  test("anything unrecorded throws DemoMissingError, read as loader-failed", async () => {
    const server = createBrowserServer({
      serve: servePack(pack, { now: NOW }),
      unserved: (k) => new DemoMissingError(k, {}),
    });
    const failed = { ok: false as const, status: 500, reason: "loader-failed" };
    expect(await read(server, greeting.key, { who: "bob" })).toEqual(failed);
    expect(await read(server, sum.key, sum.query.encode({ xs: [2] }))).toEqual(
      failed,
    );
    expect(
      await read(server, items.key, window({ where: { kind: "b" } })),
    ).toEqual(failed);
    expect(
      await read(
        server,
        items.count!.key,
        items.count!.count.encode({ where: { kind: { ne: "a" } } }),
      ),
    ).toEqual(failed);
    // A known key the pack never served: the scope's `unserved`.
    expect(await read(server, unrecorded.key, {})).toEqual(failed);
    server.dispose();
  });

  test("the loaders throw DemoMissingError (key and params) for an unrecorded tuple", () => {
    const calls: { opts: { loader?: (p: unknown) => unknown } }[] = [];
    const serve = servePack(
      definePack(() => [packValue(greeting, { who: "ada" }, { text: "hi" })]),
    );
    serve({
      serveValue: (_v: unknown, opts: { loader?: (p: unknown) => unknown }) => {
        calls.push({ opts });
        return { keys: [] };
      },
      serveCollection: () => ({ keys: [] }),
    } as unknown as Parameters<typeof serve>[0]);
    const err = (() => {
      try {
        calls[0]!.opts.loader!({ who: "bob" });
      } catch (e) {
        return e;
      }
      return null;
    })();
    expect(err).toBeInstanceOf(DemoMissingError);
    expect((err as DemoMissingError).key).toBe(greeting.key);
    expect((err as DemoMissingError).params).toEqual({ who: "bob" });
  });

  test("ago is an ISO instant counted back from load time", async () => {
    const server = serverOf(pack);
    const r = await read(
      server,
      tracks.rows.key,
      tracks.rows.point.encode(["t1"]),
    );
    if (!r.ok) throw new Error("read failed");
    expect((r.value as Item[])[0]!.at).toBe("2026-10-14T11:59:00.000Z");
    server.dispose();
  });
});

describe("loading a pack", () => {
  const loadError = (p: DemoPack): DemoPackError => {
    try {
      servePack(p);
    } catch (err) {
      if (err instanceof DemoPackError) return err;
      throw err;
    }
    throw new Error("expected the pack to fail to load");
  };

  test("a value or row its schema refuses throws DemoPackError naming the key and tuple", () => {
    const v = loadError(
      definePack(() => [
        // @ts-expect-error — `text` is a string
        packValue(greeting, { who: "ada" }, { text: 1 }),
      ]),
    );
    expect(v.key).toBe(greeting.key);
    expect(v.tuple).toBe('{"who":"ada"}');
    expect(v.message).toContain('field "text"');

    const r = loadError(
      definePack(() => [
        packWindow(items, { where: { kind: "a" } }, [
          // A cast past the types — what a stale pack's JSON would be.
          { ...item("a1", 1, "a"), rank: "1" } as unknown as Item,
        ]),
      ]),
    );
    expect(r.key).toBe(items.key);
    expect(r.message).toContain('row 0: field "rank"');
  });

  test("nothing is evaluated until the pack is served", () => {
    let evaluated = 0;
    const p = definePack(() => {
      evaluated++;
      return [];
    });
    expect(evaluated).toBe(0);
    servePack(p);
    expect(evaluated).toBe(1);
  });

  test("a tuple recorded twice, a row recorded with two shapes, or a count under the rows listed, is a DemoPackError", () => {
    expect(
      loadError(
        definePack(() => [
          packValue(greeting, { who: "ada" }, { text: "a" }),
          packValue(greeting, { who: "ada", lang: "" }, { text: "b" }),
        ]),
      ).message,
    ).toContain("recorded twice");
    expect(
      loadError(
        definePack(() => [
          packRows(byId, [item("x1", 1, "a")]),
          packRows(byId, [item("x1", 2, "a")]),
        ]),
      ).message,
    ).toContain('row "x1" is recorded twice');
    expect(
      loadError(definePack(() => [packWindow(items, {}, A, { count: 1 })]))
        .message,
    ).toContain("count 1");
  });

  test("the builders' types follow the declaration", () => {
    definePack(() => [
      // @ts-expect-error — `who` is required
      packValue(greeting, {}, { text: "x" }),
      // @ts-expect-error — `tracks` has no window
      packWindow(tracks, {}, []),
      // @ts-expect-error — `byId` is not declared `all`
      packAll(byId, []),
      // @ts-expect-error — `kind` takes "a" | "b"
      packWindow(items, { where: { kind: "c" } }, []),
    ]);
    const uncounted = liveCollection(key("uncounted"), {
      row: Item,
      id: "id",
      filterable: { kind: liveText(z.enum(["a", "b"])) },
      sortable: ["rank"],
      default: { orderBy: [["rank", "asc"]], limit: 2 },
      maxLimit: 10,
    });
    // @ts-expect-error — not declared `count: true`
    definePack(() => [packWindow(uncounted, {}, [], { count: 3 })]);
  });
});
