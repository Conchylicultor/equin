/**
 * `serveValue` / `compileValue`: the options a `liveValue` folds into, driven
 * through a real `createResourceRuntime` (no database — the db arm's change is
 * delivered through `applyLegacyFullChange`, exactly what the change feed calls), plus
 * the registering `serveValue` on the server runtime for the served shape and
 * its `Resource.Declare` payload.
 */

import { describe, expect, test } from "bun:test";
import { pgTable, text } from "drizzle-orm/pg-core";
import { z } from "zod";
import {
  createResourceRuntime,
  type ResourceParams,
} from "@plugins/framework/plugins/resource-runtime/core";
import { notificationsWsHandler } from "@plugins/framework/plugins/server-core/core";
import { liveValue } from "@plugins/network/plugins/live/core";
import { compileValue, registerValue } from "../../core/internal/compile-value";
import { serveValue, valueRuntime } from "./serve-value";

const Count = z.object({ n: z.number() });
const counts = pgTable("test_serve_value_counts", {
  id: text("id").primaryKey(),
});
const Names = z.array(z.string());

let seq = 0;
const key = (name: string) => `test.serve-value.${name}.${seq++}`;

interface Frame {
  kind: string;
  key?: string;
  params?: ResourceParams;
  value?: unknown;
}

/** A runtime + one open socket recording every frame it is sent. */
function harness(readSet: string[] = []) {
  const runtime = createResourceRuntime({ readSet: () => readSet });
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
    const h = harness(["t"]);
    const compiled = compileValue(v, { source: "db", loader: () => ({ n }) });
    expect(compiled.external).toBe(false);
    h.runtime.defineResource(v, compiled.options);
    await h.subscribe(v.key);
    expect(h.of("sub-ack", v.key)[0]!.value).toEqual({ n: 1 });

    n = 2;
    h.runtime.applyLegacyFullChange({
      source: "feed",
      table: "t",
    });
    await h.until(() => h.of("update", v.key).length > 0, "update");
    expect(h.of("update", v.key)[0]!.value).toEqual({ n: 2 });
  });

  test("an on-demand value ships an invalidate, never the value, on a change", async () => {
    const v = liveValue(key("on-demand"), {
      schema: Count,
      load: "on-demand",
    });
    let n = 1;
    const h = harness(["t"]);
    h.runtime.defineResource(
      v,
      compileValue(v, { source: "db", loader: () => ({ n }) }).options,
    );
    await h.subscribe(v.key);
    n = 2;
    h.runtime.applyLegacyFullChange({
      source: "feed",
      table: "t",
    });
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

  test("a collection-shaped db value records its reason; an empty one throws", () => {
    const v = liveValue(key("names"), { schema: Names });
    const compiled = compileValue(v, {
      source: "db",
      loader: () => [],
      unbounded: { reason: "one row per configured host" },
    });
    expect(compiled.unbounded).toEqual({
      reason: "one row per configured host",
    });
    expect(() =>
      compileValue(v, {
        source: "db",
        loader: () => [],
        unbounded: { reason: "  " },
      }),
    ).toThrow(/unbounded.reason` is empty/);
  });

  test("types: the bound rule and the params type", () => {
    const names = liveValue(key("t-names"), { schema: Names });
    const record = liveValue(key("t-record"), {
      schema: z.record(z.string(), z.number()),
    });
    const count = liveValue(key("t-count"), { schema: Count });
    const detail = liveValue(key("t-detail"), {
      schema: Count,
      params: ["id"],
    });
    // Never called — the assertions are the `@ts-expect-error`s.
    const typeOnly = () => {
      // @ts-expect-error — a db array must say why it is not a collection
      compileValue(names, { source: "db", loader: () => [] });
      // @ts-expect-error — so must a string-indexed record
      compileValue(record, { source: "db", loader: () => ({}) });
      compileValue(names, {
        source: "db",
        loader: () => [],
        unbounded: { reason: "r" },
      });
      // An in-memory array is bounded by the process that holds it.
      compileValue(names, {
        source: "external",
        changes: "notified",
        loader: () => [],
      });
      compileValue(count, {
        source: "db",
        loader: () => ({ n: 0 }),
        // @ts-expect-error — `unbounded` only on a collection-shaped db value
        unbounded: { reason: "r" },
      });
      compileValue(names, {
        source: "external",
        changes: "notified",
        loader: () => [],
        // @ts-expect-error — nor on an external one
        unbounded: { reason: "r" },
      });
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

  test("the db arm declares what its loader reads: required (tsc and a throw), refused on the external arm", () => {
    const v = liveValue(key("served-reads"), { schema: Count });
    // Never called — the assertions are the `@ts-expect-error`s.
    const typeOnly = () => {
      // @ts-expect-error — a db value declares its reads
      serveValue(v, { source: "db", loader: () => ({ n: 1 }) });
      serveValue(v, {
        source: "external",
        changes: "notified",
        loader: () => ({ n: 1 }),
        // @ts-expect-error — an external value is told of changes by its notify
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
    ).toThrow(/declares the tables its loader reads/);
    expect(() =>
      untyped(liveValue(key("served-reads-external"), { schema: Count }), {
        source: "external",
        changes: "notified",
        loader: () => ({ n: 1 }),
        reads: { tables: [counts], reason: "r" },
      }),
    ).toThrow(/`reads` is the db arm's/);
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
    const { resource } = registerValue(
      valueRuntime(v.key, opts, runtime),
      v,
      opts,
    );
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
