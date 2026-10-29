/**
 * `serveValue` / `compileValue`: the options a `liveValue` folds into, driven
 * through a real `createResourceRuntime` (no database — the db arm's change is
 * delivered through `routeTableChange`, exactly what the change feed calls), plus
 * the registering `serveValue` on the server runtime for the served shape and
 * its `Resource.Declare` payload.
 */

import { describe, expect, test } from "bun:test";
import { pgTable, pgView, text } from "drizzle-orm/pg-core";
import { z } from "zod";
import {
  createResourceRuntime,
  type ResourceParams,
} from "@plugins/framework/plugins/resource-runtime/core";
import { wholeReach } from "@plugins/framework/plugins/resource-runtime/core/testing";
import { notificationsWsHandler } from "@plugins/framework/plugins/server-core/core";
import {
  liveValue,
  type LiveQueryParams,
} from "@plugins/network/plugins/live/core";
import { compileLookup } from "@plugins/infra/plugins/query-resource/server";
import { wholeList } from "@plugins/packages/plugins/list-bound/core";
import {
  compileValue,
  registerPagedValue,
  registerValue,
} from "../../core/internal/compile-value";
import { serveValue, valueRuntime } from "./serve-value";
import {
  FOLLOW_SOURCE,
  type FollowIdsTarget,
} from "../../core/internal/follows";

const Count = z.object({ n: z.number() });
const counts = pgTable("test_serve_value_counts", {
  id: text("id").primaryKey(),
});
const countsView = pgView("test_serve_value_counts_v").as((qb) =>
  qb.select().from(counts),
);
const lists = pgTable("test_serve_value_lists", {
  id: text("id").primaryKey(),
  root: text("root"),
  noise: text("noise"),
});
const Names = wholeList(z.string(), { reason: "a test's handful of names" });
const PagedItem = z.object({ id: z.string(), at: z.string().nullable() });
type PagedItem = z.output<typeof PagedItem>;
const pagedValue = (name: string) =>
  liveValue(key(name), {
    query: z.object({ list: z.string() }),
    paged: {
      item: PagedItem,
      id: "id",
      key: { of: (i: PagedItem) => [i.at], order: ["desc"] },
      limit: 2,
      maxLimit: 4,
    },
  });

interface DebugEntry {
  key: string;
  policy: string;
  externalSource: boolean;
  freshness: { kind: string } | null;
  shape: unknown;
  routes: Array<{ id: string; table: string }> | null;
  relationReads: Array<{ relation: string; reason: string; bases: string[] }>;
}

/** One key's row of the runtime's `_debug` payload. */
async function debugOf(
  runtime: ReturnType<typeof createResourceRuntime>,
  k: string,
): Promise<DebugEntry> {
  const res = await runtime.handleResourceHttp(
    new Request("http://localhost/api/resources/_debug"),
    { key: "_debug" },
  );
  const body = (await res.json()) as { resources: DebugEntry[] };
  return body.resources.find((r) => r.key === k)!;
}

let seq = 0;
const key = (name: string) => `test.serve-value.${name}.${seq++}`;

interface Frame {
  kind: string;
  key?: string;
  params?: ResourceParams;
  value?: unknown;
}

/** A runtime + one open socket recording every frame it is sent. */
function harness() {
  const runtime = createResourceRuntime();
  const frames: Frame[] = [];
  const handler = runtime.notificationsWsHandler as any;
  const ws = {
    send(raw: string) {
      const f = JSON.parse(raw) as Frame;
      if (f.kind !== "ping") frames.push(f);
    },
  };
  handler.open(ws);
  const until = async (pred: () => boolean, what: string) => {
    for (let i = 0; i < 200; i++) {
      if (pred()) return;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error(`timed out waiting for ${what}`);
  };
  return {
    runtime,
    frames,
    /** One change to `table`, as the change feed delivers it. */
    change(table: string) {
      runtime.routeTableChange({
        source: "feed",
        table,
        op: "U",
        ids: null,
        keys: null,
        unchanged: null,
      });
    },
    async subscribe(k: string, params: ResourceParams = {}) {
      handler.message(ws, JSON.stringify({ op: "sub", key: k, params }));
      await until(
        () => frames.some((f) => f.kind === "sub-ack" && f.key === k),
        `sub-ack ${k}`,
      );
    },
    of: (kind: string, k: string) =>
      frames.filter((f) => f.kind === kind && f.key === k),
    until,
  };
}

describe("compileValue", () => {
  test("the declaration's load decides the mode: push by default, on-demand → invalidate", () => {
    const loader = () => ({ n: 1 });
    const pushed = liveValue(key("modes-default"), { schema: Count });
    expect(compileValue(pushed, { source: "db", loader }).options.mode).toBe(
      "push",
    );
    const explicit = liveValue(key("modes-push"), {
      schema: Count,
      load: "push",
    });
    expect(explicit.load).toBeUndefined();
    expect(compileValue(explicit, { source: "db", loader }).options.mode).toBe(
      "push",
    );
    const onDemand = liveValue(key("modes-on-demand"), {
      schema: Count,
      load: "on-demand",
    });
    // The client reads this same field (useResource enables the HTTP read).
    expect(onDemand.load).toBe("on-demand");
    expect(compileValue(onDemand, { source: "db", loader }).options.mode).toBe(
      "invalidate",
    );
  });

  test("serveValue takes no load: the delivery mode is the declaration's", () => {
    const v = liveValue(key("no-serve-load"), { schema: Count });
    const typeOnly = () =>
      compileValue(v, {
        source: "db",
        loader: () => ({ n: 1 }),
        // @ts-expect-error — `load` lives on liveValue, not serveValue
        load: "on-demand",
      });
    expect(typeof typeOnly).toBe("function");
  });

  test("a db value is recomputed and pushed when a table it read changes", async () => {
    const v = liveValue(key("db"), { schema: Count });
    let n = 1;
    const h = harness();
    const compiled = compileValue(v, { source: "db", loader: () => ({ n }) });
    expect(compiled.external).toBe(false);
    // The declared reads `serveValue` compiles into the registration.
    h.runtime.defineResource(v, {
      ...compiled.options,
      reach: wholeReach(["t"]),
    });
    await h.subscribe(v.key);
    expect(h.of("sub-ack", v.key)[0]!.value).toEqual({ n: 1 });

    n = 2;
    h.change("t");
    await h.until(() => h.of("update", v.key).length > 0, "update");
    expect(h.of("update", v.key)[0]!.value).toEqual({ n: 2 });
  });

  test("an on-demand value ships an invalidate, never the value, on a change", async () => {
    const v = liveValue(key("on-demand"), {
      schema: Count,
      load: "on-demand",
    });
    let n = 1;
    const h = harness();
    h.runtime.defineResource(v, {
      ...compileValue(v, { source: "db", loader: () => ({ n }) }).options,
      reach: wholeReach(["t"]),
    });
    await h.subscribe(v.key);
    n = 2;
    h.change("t");
    await h.until(() => h.of("invalidate", v.key).length > 0, "invalidate");
    expect(h.of("update", v.key)).toEqual([]);
  });

  test("an external value's notify pushes the new value", async () => {
    const v = liveValue(key("external"), { schema: Count, params: ["id"] });
    let n = 1;
    const h = harness();
    const compiled = compileValue(v, {
      source: "external",
      changes: "notified",
      loader: ({ id }) => ({ n: id === "a" ? n : -1 }),
    });
    expect(compiled.external).toBe(true);
    const r = h.runtime.defineExternalResource(v, compiled.options);
    await h.subscribe(v.key, { id: "a" });
    n = 5;
    r.notify({ id: "a" });
    await h.until(() => h.of("update", v.key).length > 0, "update");
    expect(h.of("update", v.key)[0]!.value).toEqual({ n: 5 });
  });

  test("a serve call names no list bound: `unbounded` is refused (tsc and a throw)", () => {
    // The bound is the declaration's (`wholeList` on `Names`), whatever the source.
    const v = liveValue(key("names"), { schema: Names });
    compileValue(v, { source: "db", loader: () => [] });
    compileValue(v, {
      source: "external",
      changes: "notified",
      loader: () => [],
    });
    expect(() =>
      compileValue(v, {
        source: "db",
        loader: () => [],
        // @ts-expect-error — retired: the reason lives in the schema now
        unbounded: { reason: "one row per configured host" },
      }),
    ).toThrow(/`unbounded` is not a serve option/);
    expect(() =>
      compileValue(v, {
        source: "external",
        changes: "notified",
        loader: () => [],
        // @ts-expect-error — nor on an external one
        unbounded: { reason: "r" },
      }),
    ).toThrow(/`unbounded` is not a serve option/);
  });

  test("types: the params type", () => {
    const detail = liveValue(key("t-detail"), {
      schema: Count,
      params: ["id"],
    });
    // Never called — the assertions are the `@ts-expect-error`s.
    const typeOnly = () => {
      compileValue(detail, {
        source: "db",
        // @ts-expect-error — the loader's params are the declared names
        loader: (p: { other: string }) => ({ n: p.other.length }),
      });
    };
    expect(typeof typeOnly).toBe("function");
  });
});

describe("serveValue", () => {
  test("the db arm: push by default, one Declare carrying preload, keys, and no notify", () => {
    const v = liveValue(key("served-db"), { schema: Count, preload: "boot" });
    const served = serveValue(v, {
      source: "db",
      reads: { tables: [counts], reason: "a test count" },
      loader: () => ({ n: 1 }),
    });
    expect(served.key).toBe(v.key);
    expect(served.mode).toBe("push");
    expect(served.source).toBe("db");
    expect(served.preload).toBe("boot");
    expect(served.keys).toEqual([v.key]);
    expect(served.declare).toHaveLength(1);
    expect(served.declare[0]).toMatchObject({
      key: v.key,
      mode: "push",
      preload: "boot",
    });
    expect("notify" in served).toBe(false);
    // @ts-expect-error — a Postgres-backed value is driven by the change feed alone
    expect(served.notify).toBeUndefined();
  });

  test("reads: required on the db arm, optional on a notified external (a paged one: a static list), refused on a silent one (tsc and a throw)", () => {
    const v = liveValue(key("served-reads"), { schema: Count });
    const paged = pagedValue("served-reads-paged");
    // Never called — the assertions are the `@ts-expect-error`s.
    const typeOnly = () => {
      // @ts-expect-error — a db value declares its reads
      serveValue(v, { source: "db", loader: () => ({ n: 1 }) });
      serveValue(v, {
        source: "external",
        changes: "notified",
        loader: () => ({ n: 1 }),
        reads: { tables: [counts], reason: "r" },
      });
      serveValue(v, {
        source: "external",
        changes: "notified",
        loader: () => ({ n: 1 }),
        reads: () => ({ tables: [counts], reason: "r" }),
      });
      serveValue(v, {
        source: "external",
        changes: { fixed: { reason: "a registry" } },
        loader: () => ({ n: 1 }),
        // @ts-expect-error — a fixed value claims no push: no write could tell it anything
        reads: { tables: [counts], reason: "r" },
      });
      serveValue(paged, {
        source: "external",
        changes: "notified",
        loader: () => [],
        reads: { tables: [counts], reason: "r" },
      });
      // A paged value's pages register at once: no deferred bind for a thunk
      // (no other overload takes a paged value).
      // @ts-expect-error — reported on the value argument
      serveValue(paged, {
        source: "external",
        changes: "notified",
        loader: () => [],
        reads: () => ({ tables: [counts], reason: "r" }),
      });
      // @ts-expect-error — reported on the value argument: a fixed paged value claims no push
      serveValue(paged, {
        source: "external",
        changes: { fixed: { reason: "a registry" } },
        loader: () => [],
        reads: { tables: [counts], reason: "r" },
      });
    };
    expect(typeof typeOnly).toBe("function");
    const untyped = serveValue as (v: unknown, o: unknown) => unknown;
    expect(() =>
      untyped(liveValue(key("served-reads-missing"), { schema: Count }), {
        source: "db",
        loader: () => ({ n: 1 }),
      }),
    ).toThrow(/declares what its loader reads/);
    expect(() =>
      untyped(liveValue(key("served-reads-fixed"), { schema: Count }), {
        source: "external",
        changes: { fixed: { reason: "a registry" } },
        loader: () => ({ n: 1 }),
        reads: { tables: [counts], reason: "r" },
      }),
    ).toThrow(/`reads` is a "notified" value's/);
    expect(() =>
      untyped(pagedValue("served-reads-paged-untyped"), {
        source: "external",
        changes: "notified",
        loader: () => [],
        reads: () => ({ tables: [counts], reason: "r" }),
      }),
    ).toThrow(/a paged value's `reads` is a static list/);
    expect(() =>
      untyped(pagedValue("served-reads-paged-fixed"), {
        source: "external",
        changes: { fixed: { reason: "a registry" } },
        loader: () => [],
        reads: { tables: [counts], reason: "r" },
      }),
    ).toThrow(/`reads` is a "notified" value's/);
    expect(() =>
      serveValue(liveValue(key("served-reads-empty"), { schema: Count }), {
        source: "db",
        reads: { tables: [counts], reason: "  " },
        loader: () => ({ n: 1 }),
      }),
    ).toThrow(/reason is empty/);
  });

  test("a thunk's reads compile at bindDeferredResources — the value is not served before", async () => {
    const v = liveValue(key("served-reads-thunk"), { schema: Count });
    // Its own runtime: a process-global bind would bind every other suite's
    // deferred resources too.
    const runtime = createResourceRuntime();
    const opts = {
      source: "db" as const,
      reads: () => ({ tables: [counts], reason: "a registry's tables" }),
      loader: () => ({ n: 7 }),
    };
    const { resource } = registerValue(valueRuntime(v, opts, runtime), v, opts);
    const unbound = await Promise.resolve()
      .then(() => resource.load({}))
      .then(
        () => null,
        (err: unknown) => err,
      );
    expect(unbound).toBeInstanceOf(Error);
    expect((unbound as Error).message).toMatch(/deferred and not bound yet/);
    runtime.bindDeferredResources();
    expect(await resource.load({})).toEqual({ n: 7 });
    expect(runtime.scopedResourceTables()).toEqual([
      {
        key: v.key,
        table: "test_serve_value_counts",
        via: 'route "test_serve_value_counts"',
      },
    ]);
  });

  test("an external value with reads registers routed: external, its notify kept, a write to a declared table recomputes it", async () => {
    const v = liveValue(key("served-ext-reads"), { schema: Count });
    const h = harness();
    const runtime = h.runtime;
    let n = 0;
    const opts = {
      source: "external" as const,
      changes: "notified" as const,
      reads: {
        tables: [counts, countsView],
        reason: "a lookup beside its files",
      },
      loader: () => ({ n: ++n }),
    };
    const { resource } = registerValue(valueRuntime(v, opts, runtime), v, opts);
    expect("notify" in resource).toBe(true);
    const entry = await debugOf(runtime, v.key);
    expect(entry.policy).toBe("external");
    expect(entry.freshness).toEqual({ kind: "notified" });
    expect(entry.routes?.map((r) => r.table)).toEqual([
      "test_serve_value_counts",
    ]);
    expect(entry.relationReads.map((r) => r.relation)).toEqual([
      "test_serve_value_counts_v",
    ]);
    expect(runtime.unroutedResourceKeys()).toEqual([]);
    expect(runtime.scopedResourceTables()).toEqual([
      {
        key: v.key,
        table: "test_serve_value_counts",
        via: 'route "test_serve_value_counts"',
      },
    ]);
    await h.subscribe(v.key);
    runtime.routeTableChange({
      source: "feed",
      table: "test_serve_value_counts",
      op: "U",
      ids: ["x"],
      keys: null,
      unchanged: null,
    });
    await h.until(
      () =>
        h.of("update", v.key).some((f) => (f.value as { n: number }).n === 2),
      "the routed recompute",
    );
  });

  test("a paged value with reads: its pages and its meta share one full-only reach plan — a write re-reads the subscribed page and recomputes the meta", async () => {
    const v = liveValue(key("served-paged-reads"), {
      query: z.object({ list: z.string() }),
      paged: {
        item: PagedItem,
        id: "id",
        key: { of: (i: PagedItem) => [i.at], order: ["desc"] },
        limit: 2,
        maxLimit: 4,
        meta: Count,
      },
    });
    const h = harness();
    const runtime = h.runtime;
    let pageLoads = 0;
    let metaLoads = 0;
    const opts = {
      source: "external" as const,
      changes: "notified" as const,
      reads: {
        tables: [counts, countsView],
        reason: "each question resolves its list through a lookup",
      },
      loader: () => {
        pageLoads++;
        return [{ id: `a${pageLoads}`, at: "1" }];
      },
      meta: () => ({ n: ++metaLoads }),
    };
    const { resource, meta } = registerPagedValue(
      valueRuntime(v, opts, runtime),
      v,
      opts,
    );
    // The bases are known (server-core's `setRelationBases` runs this).
    runtime.indexRelationReads();
    const pages = await debugOf(runtime, v.key);
    expect(pages.policy).toBe("external");
    // The keyed pages take the same reach plan as every other arm (D31: a
    // full-only plan): a whole-table route, a view as a relation read.
    expect(pages.routes?.map((r) => r.table)).toEqual([
      "test_serve_value_counts",
    ]);
    expect(pages.relationReads.map((r) => r.relation)).toEqual([
      "test_serve_value_counts_v",
    ]);
    const metaEntry = await debugOf(runtime, meta!.resource.key);
    expect(metaEntry.routes?.map((r) => r.table)).toEqual([
      "test_serve_value_counts",
    ]);
    // Change-feed's A1′ holds the view's bases to a change source.
    expect(
      runtime
        .relationResourceReads()
        .filter((r) => r.key === v.key)
        .map((r) => r.relation),
    ).toEqual(["test_serve_value_counts_v"]);
    const page = v.query.encode(
      { list: "x" },
      { after: null, until: null, limit: 2 },
    );
    await h.subscribe(resource.key, page);
    await h.subscribe(meta!.resource.key, {
      q: v.query.encodeQuery({ list: "x" }),
    });
    const [loadsBefore, metaBefore] = [pageLoads, metaLoads];
    h.change("test_serve_value_counts");
    await h.until(
      () => pageLoads > loadsBefore && metaLoads > metaBefore,
      "the page re-read and the meta recompute",
    );
    await h.until(
      () => h.of("delta", resource.key).length > 0,
      "the page's keyed delta",
    );
  });

  test("a paged value reading through a lookup: a write the lookup's gate skips reaches no page, a write to one question's row only that question's pages and meta", async () => {
    const v = liveValue(key("served-paged-lookup"), {
      query: z.object({ list: z.string() }),
      paged: {
        item: PagedItem,
        id: "id",
        key: { of: (i: PagedItem) => [i.at], order: ["desc"] },
        limit: 2,
        maxLimit: 4,
        meta: Count,
      },
    });
    const listRoot = compileLookup({
      label: "test.serve-value.list-root",
      from: lists,
      by: lists.id,
      select: { root: { from: "base", col: lists.root } },
      row: z.object({ root: z.string().nullable() }),
    });
    const listOf = (q: string) => (JSON.parse(q) as { list: string }).list;
    const h = harness();
    const runtime = h.runtime;
    const loads: string[] = [];
    const opts = {
      source: "external" as const,
      changes: "notified" as const,
      reads: {
        tables: [],
        lookups: [listRoot.read<LiveQueryParams>((p) => listOf(p.q))],
        reason: "unused: every read is the lookup's",
      },
      loader: (q: { list: string }) => {
        loads.push(`page ${q.list}`);
        return [{ id: `${q.list}${loads.length}`, at: "1" }];
      },
      meta: (q: { list: string }) => {
        loads.push(`meta ${q.list}`);
        return { n: loads.length };
      },
    };
    const { resource, meta } = registerPagedValue(
      valueRuntime(v, opts, runtime),
      v,
      opts,
    );
    // The pages' reach plan: the lookup's own route, gated on what it reads.
    const pages = await debugOf(runtime, v.key);
    expect(pages.routes).toEqual([
      expect.objectContaining({
        id: "test.serve-value.list-root:test_serve_value_lists",
        table: "test_serve_value_lists",
      }),
    ]);
    for (const list of ["x", "y"]) {
      await h.subscribe(
        resource.key,
        v.query.encode({ list }, { after: null, until: null, limit: 2 }),
      );
      await h.subscribe(meta!.resource.key, {
        q: v.query.encodeQuery({ list }),
      });
    }
    const settle = () => new Promise((r) => setTimeout(r, 30));
    const write = (
      op: "I" | "U" | "D",
      id: string,
      unchanged: string[] | null,
    ) =>
      runtime.routeTableChange({
        source: "feed",
        table: "test_serve_value_lists",
        op,
        ids: [id],
        keys: { id: [id] },
        unchanged,
      });
    // Every first load in (a meta's sub-ack may land after its frame).
    await settle();
    // A column the lookup does not read: gated out, no page or meta re-reads.
    loads.length = 0;
    write("U", "x", ["id", "root"]);
    await settle();
    expect(loads).toEqual([]);
    // An insert of question x's row: only x's page and meta.
    write("I", "x", null);
    await h.until(() => loads.length >= 2, "x's page and meta");
    await settle();
    expect(loads.sort()).toEqual(["meta x", "page x"]);
    // A write to another row reaches neither question.
    loads.length = 0;
    write("D", "z", null);
    await settle();
    expect(loads).toEqual([]);
    // A column it reads, on y's row: only y.
    write("U", "y", ["id"]);
    await h.until(() => loads.length >= 2, "y's page and meta");
    await settle();
    expect(loads.sort()).toEqual(["meta y", "page y"]);
  });

  test("an external thunk binds deferred: external with its freshness from definition, its plan at bindDeferredResources", async () => {
    const v = liveValue(key("served-ext-thunk"), { schema: Count });
    // Its own runtime: a process-global bind would bind every other suite's
    // deferred resources too.
    const runtime = createResourceRuntime();
    const opts = {
      source: "external" as const,
      changes: "notified" as const,
      reads: () => ({ tables: [counts], reason: "a provider's tables" }),
      loader: () => ({ n: 3 }),
    };
    const { resource } = registerValue(valueRuntime(v, opts, runtime), v, opts);
    expect("notify" in resource).toBe(true);
    const unbound = await debugOf(runtime, v.key);
    expect(unbound.policy).toBe("unbound");
    expect(unbound.externalSource).toBe(true);
    expect(unbound.freshness).toEqual({ kind: "notified" });
    runtime.bindDeferredResources();
    const bound = await debugOf(runtime, v.key);
    expect(bound.policy).toBe("external");
    expect(bound.routes?.map((r) => r.table)).toEqual([
      "test_serve_value_counts",
    ]);
    expect(await resource.load({})).toEqual({ n: 3 });
  });

  test("the declaration's list shape rides _debug — a deferred placeholder's too", async () => {
    const v = liveValue(key("served-shape"), {
      schema: z.object({
        rows: z
          .array(
            z.object({
              parts: wholeList(z.string(), { reason: "a row's few parts" }),
            }),
          )
          .max(50),
      }),
    });
    const shape = {
      paged: false,
      bounds: [
        { path: "rows", max: 50 },
        { path: "rows[].parts", reason: "a row's few parts" },
      ],
      bare: [],
    };
    const runtime = createResourceRuntime();
    const opts = {
      source: "external" as const,
      changes: "notified" as const,
      reads: () => ({ tables: [counts], reason: "a provider's tables" }),
      loader: () => ({ rows: [] }),
    };
    registerValue(valueRuntime(v, opts, runtime), v, opts);
    expect((await debugOf(runtime, v.key)).shape).toEqual(shape);
    runtime.bindDeferredResources();
    expect((await debugOf(runtime, v.key)).shape).toEqual(shape);

    const plain = liveValue(key("served-shape-plain"), { schema: Count });
    const plainOpts = {
      source: "external" as const,
      changes: { fixed: { reason: "a constant" } },
      loader: () => ({ n: 1 }),
    };
    registerValue(valueRuntime(plain, {}, runtime), plain, plainOpts);
    expect((await debugOf(runtime, plain.key)).shape).toEqual({
      paged: false,
      bounds: [],
      bare: [],
    });
  });

  test("types: a central value is not served here", () => {
    const central = liveValue(key("served-central"), {
      schema: Count,
      origin: "central",
    });
    expect(central.origin).toBe("central");
    // Never called — the assertion is the `@ts-expect-error`.
    const typeOnly = () =>
      // @ts-expect-error — a central value is served by network/live/central
      serveValue(central, {
        source: "external",
        changes: "notified",
        loader: () => ({ n: 1 }),
      });
    expect(typeof typeOnly).toBe("function");
  });

  test("the external arm has notify; on-demand is served as invalidate", () => {
    const v = liveValue(key("served-ext"), {
      schema: Count,
      load: "on-demand",
    });
    const served = serveValue(v, {
      source: "external",
      changes: "notified",
      loader: () => ({ n: 1 }),
    });
    expect(served.mode).toBe("invalidate");
    expect(served.source).toBe("external");
    expect(typeof served.notify).toBe("function");
    expect(served.declare[0]).toMatchObject({ key: v.key, mode: "invalidate" });
    expect(served.declare[0]!.preload).toBeUndefined();
    served.notify();
  });

  test("a param'd preloaded value must name its boot tuples; the Declare loads them, canonical", async () => {
    const v = liveValue(key("served-param-preload"), {
      schema: Count,
      params: ["path", "scopeId?"],
      preload: "boot-and-keep",
    });
    // Never called — the assertion is the `@ts-expect-error`.
    const typeOnly = () =>
      // @ts-expect-error — `preloadParams` is required for a param'd preloaded value
      serveValue(v, {
        source: "external",
        changes: "notified",
        loader: () => ({ n: 1 }),
      });
    expect(typeof typeOnly).toBe("function");
    // …and an untyped caller is refused at serve time.
    expect(() =>
      (serveValue as (v: unknown, o: unknown) => unknown)(v, {
        source: "external",
        changes: "notified",
        loader: () => ({ n: 1 }),
      }),
    ).toThrow(/must pass `preloadParams`/);

    const served = serveValue(v, {
      source: "external",
      changes: "notified",
      loader: ({ scopeId }) => {
        if (scopeId === "broken") throw new Error("boom");
        return { n: scopeId === undefined ? 0 : 1 };
      },
      preloadParams: () => [
        { path: "a" },
        { path: "a", scopeId: "" },
        { path: "a", scopeId: "s" },
        { path: "a", scopeId: "broken" },
      ],
    });
    expect(served.declare[0]).toMatchObject({
      key: v.key,
      preload: "boot-and-keep",
    });
    // A contribution's payload fields read back as `unknown`.
    const load = served.declare[0]!.preloadTuples as
      (() => Promise<unknown[]>) | undefined;
    expect(load).toBeDefined();
    // The same canonical tuples a read subscribes (`""` is an absent optional),
    // each loaded and settled on its own.
    expect(await load!()).toEqual([
      { params: { path: "a" }, ok: true, value: { n: 0 } },
      { params: { path: "a" }, ok: true, value: { n: 0 } },
      { params: { path: "a", scopeId: "s" }, ok: true, value: { n: 1 } },
      {
        params: { path: "a", scopeId: "broken" },
        ok: false,
        error: expect.any(Error),
      },
    ]);
  });

  test("preloadParams is refused on any other value", () => {
    const v = liveValue(key("served-plain-preload-params"), {
      schema: Count,
      params: ["id"],
    });
    const typeOnly = () =>
      serveValue(v, {
        source: "external",
        changes: "notified",
        loader: () => ({ n: 1 }),
        // @ts-expect-error — only a param'd value declared `preload` names boot tuples
        preloadParams: () => [{ id: "a" }],
      });
    expect(typeof typeOnly).toBe("function");
    expect(() =>
      (serveValue as (v: unknown, o: unknown) => unknown)(v, {
        source: "external",
        changes: "notified",
        loader: () => ({ n: 1 }),
        preloadParams: () => [{ id: "a" }],
      }),
    ).toThrow(/only for a/);
  });

  test("notify is canonical: every spelling of an absent optional param reaches the one tuple", async () => {
    const v = liveValue(key("served-optional-notify"), {
      schema: Count,
      params: ["path", "scopeId?"],
    });
    let n = 0;
    const served = serveValue(v, {
      source: "external",
      changes: "notified",
      loader: () => ({ n: n++ }),
    });
    const frames: Frame[] = [];
    const handler = notificationsWsHandler as any;
    const ws = {
      send(raw: string) {
        const f = JSON.parse(raw) as Frame;
        if (f.kind !== "ping" && f.key === v.key) frames.push(f);
      },
    };
    handler.open(ws);
    const until = async (pred: () => boolean, what: string) => {
      for (let i = 0; i < 200; i++) {
        if (pred()) return;
        await new Promise((r) => setTimeout(r, 5));
      }
      throw new Error(`timed out waiting for ${what}`);
    };
    handler.message(
      ws,
      JSON.stringify({ op: "sub", key: v.key, params: { path: "a" } }),
    );
    await until(() => frames.some((f) => f.kind === "sub-ack"), "sub-ack");
    for (const spelling of [
      { path: "a", scopeId: "" },
      { path: "a", scopeId: undefined } as unknown as { path: string },
    ]) {
      const before = frames.filter((f) => f.kind === "update").length;
      served.notify(spelling);
      await until(
        () => frames.filter((f) => f.kind === "update").length > before,
        "update",
      );
    }
    expect(
      frames
        .filter((f) => f.kind === "update")
        .every((f) => f.params?.scopeId === undefined),
    ).toBe(true);
    handler.close(ws);
  });
});

describe("serveValue — follows on every arm (types)", () => {
  interface Ws {
    id: string;
    path: string;
  }
  const rowsTarget: FollowIdsTarget<Ws> = {
    [FOLLOW_SOURCE]: {
      form: "ids",
      collection: "t:rows",
      read: () => Promise.resolve([]),
      reach: () => null,
      deferred: false,
    },
  };

  test("db, notified external and paged values take follows; reads is optional beside one; a silent value takes none", () => {
    const plain = liveValue("test.serve-value.follows-types", {
      schema: z.object({ n: z.number() }),
      params: ["id"],
    });
    const paged = liveValue("test.serve-value.follows-types-paged", {
      query: z.object({ id: z.string() }),
      paged: {
        item: z.object({ id: z.string() }),
        id: "id",
        key: { of: (i: { id: string }) => [i.id], order: ["asc"] as const },
        limit: 5,
        maxLimit: 10,
      },
    });
    // Never called — the assertions are the types (and `@ts-expect-error`s).
    const typeOnly = () => {
      serveValue(plain, {
        source: "db",
        follows: (follow) => ({
          ws: follow(rowsTarget, ({ id }) => ({ ids: [id] })),
        }),
        loader: (_p, { followed }) => ({ n: followed.ws.length }),
        whileFollowing: {
          over: (followed) => followed.ws.map((r) => r.path),
          start: (_p, { over: paths }) => {
            const typed: readonly string[] = paths;
            return () => void typed;
          },
        },
      });
      serveValue(plain, {
        source: "external",
        changes: "notified",
        follows: (follow) => ({
          ws: follow(rowsTarget, ({ id }) => ({ ids: [id] })),
        }),
        loader: (_p, { followed }) => ({ n: followed.ws.length }),
        whileFollowing: {
          over: (followed) => followed.ws.length,
          start: (_p, { over: n, notify }) => {
            notify();
            return () => void n;
          },
        },
      });
      serveValue(paged, {
        source: "external",
        changes: "notified",
        follows: (follow) => ({
          ws: follow(rowsTarget, ({ id }) => ({ ids: [id] })),
        }),
        loader: (_q, _range, { followed }) =>
          followed.ws.map((r) => ({ id: r.id })),
      });
      // @ts-expect-error — a db value without follows declares its reads
      serveValue(plain, { source: "db", loader: () => ({ n: 0 }) });
      serveValue(plain, {
        source: "external",
        changes: { fixed: { reason: "r" } },
        // @ts-expect-error — a value with no change signal follows nothing
        follows: (follow) => ({
          ws: follow(rowsTarget, ({ id }: { id: string }) => ({ ids: [id] })),
        }),
        loader: () => ({ n: 0 }),
      });
    };
    expect(typeof typeOnly).toBe("function");
  });
});
