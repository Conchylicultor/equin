/**
 * The value options `compileValue` folds into the runtime — `throttleMs`,
 * `recomputeOn`, `whileSubscribed`, `revalidate` — driven through a real
 * `createResourceRuntime` via `registerValue` (the one path both `serveValue`s
 * take), with a fake socket that subscribes and unsubscribes.
 */

import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  createResourceRuntime,
  type ResourceParams,
} from "@plugins/framework/plugins/resource-runtime/core";
import {
  LIVE_ROW_KEY_MAX_BYTES,
  liveValue,
  type LiveKeyRange,
} from "@plugins/network/plugins/live/core";
import {
  compilePagedValue,
  compileQueryValue,
  compileValue,
  registerPagedValue,
  registerQueryValue,
  registerValue,
  type ServedValueBase,
  type StopFn,
} from "./compile-value";

const Count = z.object({ n: z.number() });
const Sha = z.object({ sha: z.string() });

let seq = 0;
const key = (name: string) => `test.compile-value.${name}.${seq++}`;

interface Frame {
  kind: string;
  key?: string;
  params?: ResourceParams;
  value?: unknown;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
      await sleep(5);
    }
    throw new Error(`timed out waiting for ${what}`);
  };
  const acks = (k: string, params: ResourceParams) =>
    frames.filter(
      (f) =>
        f.kind === "sub-ack" &&
        f.key === k &&
        JSON.stringify(f.params) === JSON.stringify(params),
    ).length;
  return {
    runtime,
    frames,
    until,
    async subscribe(k: string, params: ResourceParams = {}) {
      const before = acks(k, params);
      handler.message(ws, JSON.stringify({ op: "sub", key: k, params }));
      await until(() => acks(k, params) > before, `sub-ack ${k}`);
    },
    unsubscribe(k: string, params: ResourceParams = {}) {
      handler.message(ws, JSON.stringify({ op: "unsub", key: k, params }));
    },
    of: (kind: string, k: string) =>
      frames.filter((f) => f.kind === kind && f.key === k),
  };
}

/** An external upstream `{ refName }` value registered on `runtime`. */
function upstream(runtime: ReturnType<typeof createResourceRuntime>) {
  const v = liveValue(key("ref"), { schema: Sha, params: ["refName"] });
  const { resource } = registerValue(runtime, v, {
    source: "external",
    changes: "notified",
    loader: () => ({ sha: "s" }),
  });
  const served = {
    ...resource,
    source: "external" as const,
    keys: [v.key],
  } as ServedValueBase<{ sha: string }, { refName: string }> & {
    notify(p?: { refName: string }): void;
  };
  return served;
}

describe("throttleMs", () => {
  test("a burst of notifies coalesces into one recompute", async () => {
    const h = harness();
    const v = liveValue(key("throttle"), { schema: Count });
    let loads = 0;
    const { resource } = registerValue(h.runtime, v, {
      source: "external",
      changes: "notified",
      throttleMs: 40,
      loader: () => ({ n: ++loads }),
    });
    await h.subscribe(v.key);
    const afterSub = loads;
    const notify = (resource as { notify(): void }).notify;
    for (let i = 0; i < 5; i++) notify();
    await sleep(10);
    // Still inside the window: nothing flushed yet.
    expect(loads).toBe(afterSub);
    await h.until(() => h.of("update", v.key).length > 0, "update");
    await sleep(60);
    expect(loads).toBe(afterSub + 1);
    expect(h.of("update", v.key)).toHaveLength(1);
  });
});

describe("recomputeOn", () => {
  test("bare: every subscribed tuple recomputes, and no unsubscribed one", async () => {
    const h = harness();
    const ref = upstream(h.runtime);
    const v = liveValue(key("bare"), { schema: Count, params: ["id"] });
    const loaded: string[] = [];
    registerValue(h.runtime, v, {
      source: "external",
      changes: "notified",
      recomputeOn: [ref],
      loader: ({ id }) => {
        loaded.push(id);
        return { n: loaded.length };
      },
    });
    await h.subscribe(v.key, { id: "a" });
    await h.subscribe(v.key, { id: "b" });
    await h.subscribe(v.key, { id: "c" });
    h.unsubscribe(v.key, { id: "c" });
    loaded.length = 0;

    ref.notify({ refName: "refs/heads/main" });
    await h.until(() => loaded.length >= 2, "downstream loads");
    await sleep(20);
    expect([...loaded].sort()).toEqual(["a", "b"]);
  });

  test("bare, on a param-less value: its one tuple recomputes", async () => {
    const h = harness();
    const ref = upstream(h.runtime);
    const v = liveValue(key("bare-paramless"), { schema: Count });
    let loads = 0;
    registerValue(h.runtime, v, {
      source: "external",
      changes: "notified",
      recomputeOn: [ref],
      loader: () => ({ n: ++loads }),
    });
    await h.subscribe(v.key);
    ref.notify({ refName: "refs/heads/main" });
    await h.until(() => h.of("update", v.key).length > 0, "update");
    expect(h.of("update", v.key)[0]!.value).toEqual({ n: 2 });
  });

  test("mapped: only the tuple the upstream's params map to recomputes", async () => {
    const h = harness();
    const ref = upstream(h.runtime);
    const v = liveValue(key("mapped"), { schema: Count, params: ["branch"] });
    const loaded: string[] = [];
    registerValue(h.runtime, v, {
      source: "external",
      changes: "notified",
      recomputeOn: [
        { value: ref, params: ({ refName }) => ({ branch: refName }) },
      ],
      loader: ({ branch }) => {
        loaded.push(branch);
        return { n: loaded.length };
      },
    });
    await h.subscribe(v.key, { branch: "main" });
    await h.subscribe(v.key, { branch: "other" });
    loaded.length = 0;

    ref.notify({ refName: "main" });
    await h.until(() => loaded.length >= 1, "downstream load");
    await sleep(20);
    expect(loaded).toEqual(["main"]);
  });

  test("types: a mapped entry sees its upstream's params and returns this value's", () => {
    const runtime = createResourceRuntime();
    const ref = upstream(runtime);
    const v = liveValue(key("t-mapped"), { schema: Count, params: ["id"] });
    // Never called — the assertions are the `@ts-expect-error`s.
    const typeOnly = () => {
      compileValue(v, {
        source: "external",
        changes: "notified",
        loader: () => ({ n: 0 }),
        recomputeOn: [
          // @ts-expect-error — the upstream has `refName`, not `id`
          { value: ref, params: ({ id }) => ({ id }) },
        ],
      });
      compileValue(v, {
        source: "external",
        changes: "notified",
        loader: () => ({ n: 0 }),
        recomputeOn: [
          // @ts-expect-error — must return THIS value's params
          { value: ref, params: ({ refName }) => ({ branch: refName }) },
        ],
      });
    };
    expect(typeof typeOnly).toBe("function");
  });
});

// T15: a `recomputeOn` upstream is EXTERNAL. A db value's writes reach every
// reader of its tables through the change feed already, so a cascade out of
// one would serve its downstream twice. Rung 2: `ExternalServed` is told apart
// by `notify`, which a db value has none of; the runtime still refuses one an
// erased cast let through.
describe("recomputeOn — only an external upstream (T15)", () => {
  function dbUpstream(runtime: ReturnType<typeof createResourceRuntime>) {
    const v = liveValue(key("db-up"), { schema: Count });
    const { resource } = registerValue(runtime, v, {
      source: "db",
      loader: () => ({ n: 0 }),
    });
    const served: ServedValueBase<{ n: number }, Record<string, string>> = {
      ...resource,
      source: "db",
      keys: [v.key],
    };
    return served;
  }

  test("types: a db upstream is refused, bare and mapped", () => {
    const runtime = createResourceRuntime();
    const db = dbUpstream(runtime);
    const v = liveValue(key("t-db"), { schema: Count });
    // Never called — the assertions are the `@ts-expect-error`s.
    const typeOnly = () => {
      compileValue(v, {
        source: "external",
        changes: "notified",
        loader: () => ({ n: 0 }),
        // @ts-expect-error — a db value has no `notify`: not an upstream
        recomputeOn: [db],
      });
      compileValue(v, {
        source: "db",
        loader: () => ({ n: 0 }),
        recomputeOn: [
          // @ts-expect-error — mapped, the same: only an external upstream
          { value: db, params: () => ({}) },
        ],
      });
    };
    expect(typeof typeOnly).toBe("function");
  });

  test("a db upstream an erased cast let through is refused at registration; an external one registers", () => {
    const runtime = createResourceRuntime();
    const db = dbUpstream(runtime);
    expect(() =>
      registerValue(runtime, liveValue(key("down-db"), { schema: Count }), {
        source: "db",
        loader: () => ({ n: 0 }),
        recomputeOn: [db as never],
      }),
    ).toThrow(/which is DB-backed/);
    const ref = upstream(runtime);
    expect(() =>
      registerValue(runtime, liveValue(key("down-ext"), { schema: Count }), {
        source: "db",
        loader: () => ({ n: 0 }),
        recomputeOn: [ref],
      }),
    ).not.toThrow();
  });
});

describe("whileSubscribed", () => {
  test("starts once per first subscriber, stops once per last unsubscribe", async () => {
    const h = harness();
    const v = liveValue(key("lifecycle"), { schema: Count, params: ["id"] });
    const log: string[] = [];
    registerValue(h.runtime, v, {
      source: "db",
      loader: () => ({ n: 1 }),
      whileSubscribed: ({ id }): StopFn => {
        log.push(`start ${id}`);
        return () => log.push(`stop ${id}`);
      },
    });
    // A second socket holding the same tuple keeps it subscribed.
    const other = {
      send() {},
    };
    const handler = h.runtime.notificationsWsHandler as any;
    handler.open(other);
    await h.subscribe(v.key, { id: "a" });
    handler.message(
      other,
      JSON.stringify({ op: "sub", key: v.key, params: { id: "a" } }),
    );
    await sleep(10);
    expect(log).toEqual(["start a"]);
    h.unsubscribe(v.key, { id: "a" });
    expect(log).toEqual(["start a"]);
    handler.message(
      other,
      JSON.stringify({ op: "unsub", key: v.key, params: { id: "a" } }),
    );
    expect(log).toEqual(["start a", "stop a"]);
  });

  test("external: notify recomputes the tuple it was handed", async () => {
    const h = harness();
    const v = liveValue(key("watch"), { schema: Count, params: ["id"] });
    let fire: (() => void) | undefined;
    let n = 1;
    registerValue(h.runtime, v, {
      source: "external",
      changes: "notified",
      loader: () => ({ n }),
      whileSubscribed: (_params, notify) => {
        fire = notify;
        return () => {};
      },
    });
    await h.subscribe(v.key, { id: "a" });
    n = 7;
    fire!();
    await h.until(() => h.of("update", v.key).length > 0, "update");
    expect(h.of("update", v.key)[0]).toMatchObject({
      params: { id: "a" },
      value: { n: 7 },
    });
  });

  test("a stop that arrives before an async start resolves runs after it", async () => {
    const h = harness();
    const v = liveValue(key("async"), { schema: Count, params: ["id"] });
    const log: string[] = [];
    let resolveStart: ((stop: StopFn) => void) | undefined;
    const compiled = compileValue(v, {
      source: "external",
      changes: "notified",
      loader: () => ({ n: 1 }),
      whileSubscribed: ({ id }) =>
        new Promise<StopFn>((resolve) => {
          log.push(`start ${id}`);
          resolveStart = resolve;
        }),
    });
    compiled.bindNotify(() => {});
    // Drive the paired hooks directly: the runtime awaits the start on the
    // subscribe path, so a real unsubscribe cannot overtake it through a socket.
    const started = compiled.options.onFirstSubscribe!({ id: "a" });
    compiled.options.onLastUnsubscribe!({ id: "a" });
    expect(log).toEqual(["start a"]);
    resolveStart!(() => log.push("stop a"));
    await started;
    await sleep(0);
    expect(log).toEqual(["start a", "stop a"]);
    expect(h.frames).toEqual([]);
  });

  test("a start that failed has nothing to stop, and its rejection reaches the runtime", async () => {
    const v = liveValue(key("fail"), { schema: Count, params: ["id"] });
    const compiled = compileValue(v, {
      source: "db",
      loader: () => ({ n: 1 }),
      whileSubscribed: () => Promise.reject(new Error("no worktree")),
    });
    const started = compiled.options.onFirstSubscribe!({ id: "a" });
    compiled.options.onLastUnsubscribe!({ id: "a" });
    expect(started).rejects.toThrow("no worktree");
    await sleep(0);
  });

  test("types: the db arm is handed no notify", () => {
    const v = liveValue(key("t-db"), { schema: Count, params: ["id"] });
    // Never called — the assertion is the `@ts-expect-error`.
    const typeOnly = () =>
      compileValue(v, {
        source: "db",
        loader: () => ({ n: 0 }),
        // @ts-expect-error — a db value is driven by the change feed alone
        whileSubscribed: (_p: { id: string }, notify: () => void) => notify,
      });
    expect(typeof typeOnly).toBe("function");
  });
});

describe("revalidate", () => {
  test("is passed through to the runtime", () => {
    const v = liveValue(key("reval"), { schema: Count });
    const revalidate = () => Promise.resolve("etag");
    const compiled = compileValue(v, {
      source: "external",
      changes: "notified",
      loader: () => ({ n: 0 }),
      revalidate,
    });
    expect(compiled.options.revalidate).toBe(revalidate);
  });
});

describe("typed-query values", () => {
  const Query = z.object({ metric: z.string(), days: z.number().default(7) });

  test("the loader and whileSubscribed get the decoded question; notify(q) recomputes exactly its tuple", async () => {
    const h = harness();
    const v = liveValue(key("query"), { schema: Count, query: Query });
    const seen: unknown[] = [];
    const started: unknown[] = [];
    let n = 1;
    const { resource, compiled } = registerQueryValue(h.runtime, v, {
      source: "external",
      changes: "notified",
      loader: (q) => {
        seen.push(q);
        return { n: n * q.days };
      },
      whileSubscribed: (q) => {
        started.push(q);
        return () => {};
      },
    });
    const a = v.query.encode({ metric: "a" });
    const b = v.query.encode({ metric: "b", days: 2 });
    await h.subscribe(v.key, a);
    await h.subscribe(v.key, b);
    expect(seen).toContainEqual({ metric: "a", days: 7 });
    expect(started).toEqual([
      { metric: "a", days: 7 },
      { metric: "b", days: 2 },
    ]);
    // notify(q) → that question's one tuple, encoded by the declaration's codec.
    expect(compiled.tuplesOf({ metric: "a", days: 7 })).toEqual([a]);
    n = 3;
    for (const t of compiled.tuplesOf({ metric: "a", days: 7 })) {
      (resource as { notify(p: unknown): void }).notify(t);
    }
    await h.until(() => h.of("update", v.key).length > 0, "update");
    await sleep(20);
    expect(h.of("update", v.key)).toEqual([
      expect.objectContaining({ params: a, value: { n: 21 } }),
    ]);
  });

  test("types: the loader takes the question's output, a mapped recomputeOn returns a question", () => {
    const v = liveValue(key("t-query"), { schema: Count, query: Query });
    const typeOnly = () =>
      compileQueryValue(v, {
        source: "external",
        changes: "notified",
        // `days` is defaulted: present on the output.
        loader: (q) => ({ n: q.days }),
      });
    const typeOnly2 = () =>
      compileQueryValue(v, {
        source: "external",
        changes: "notified",
        // @ts-expect-error — the loader is handed the question, not `{ q }`
        loader: (p: { q: string }) => ({ n: p.q.length }),
      });
    expect(typeof typeOnly).toBe("function");
    expect(typeof typeOnly2).toBe("function");
  });
});

describe("paged values", () => {
  const Item = z.object({ id: z.string(), at: z.string().nullable() });
  type Item = z.output<typeof Item>;
  const Selector = z.object({ metric: z.string() });
  const Meta = z.object({ total: z.number() });
  const key_ = { of: (i: Item) => [i.at], order: ["desc"] as const };

  function pagedValue(name: string) {
    return liveValue(key(name), {
      query: Selector,
      paged: {
        item: Item,
        id: "id",
        key: key_,
        limit: 2,
        maxLimit: 4,
        meta: Meta,
      },
    });
  }
  function bareValue(name: string) {
    return liveValue(key(name), {
      query: Selector,
      paged: { item: Item, id: "id", key: key_, limit: 2, maxLimit: 4 },
    });
  }
  const page = (after: string | null, until: string | null, limit = 2) => ({
    after,
    until,
    limit,
  });

  test("the loader gets the question and its decoded key range; each item is minted its $key", async () => {
    const h = harness();
    const v = pagedValue("paged");
    const asks: unknown[] = [];
    registerPagedValue(h.runtime, v, {
      source: "external",
      changes: "notified",
      loader: (q, range) => {
        asks.push([q, range]);
        return range.after === null
          ? [
              { id: `${q.metric}-a`, at: "2" },
              { id: "b", at: null },
            ]
          : [];
      },
      meta: () => ({ total: 2 }),
    });
    const p0 = v.query.encode({ metric: "m" }, page(null, null));
    const p1 = v.query.encode({ metric: "m" }, page('[null,"b"]', null, 4));
    await h.subscribe(v.key, p0);
    await h.subscribe(v.key, p1);
    expect(asks).toEqual([
      [{ metric: "m" }, { after: null, until: null, limit: 2 }],
      [
        { metric: "m" },
        { after: { key: [null], id: "b" }, until: null, limit: 4 },
      ],
    ]);
    const ack = h.frames.find(
      (f) =>
        f.kind === "sub-ack" && JSON.stringify(f.params) === JSON.stringify(p0),
    );
    expect(ack?.value).toEqual([
      { id: "m-a", at: "2", $key: '["2","m-a"]' },
      { id: "b", at: null, $key: '[null,"b"]' },
    ]);
  });

  test.each<[string, (range: LiveKeyRange) => unknown[], RegExp]>([
    [
      "over the limit",
      () => [
        { id: "a", at: "3" },
        { id: "b", at: "2" },
        { id: "c", at: "1" },
      ],
      /3 items for a page of at most 2/,
    ],
    [
      "out of order",
      () => [
        { id: "a", at: "1" },
        { id: "b", at: "2" },
      ],
      /not in strictly ascending key order/,
    ],
    [
      "an id twice",
      () => [
        { id: "a", at: "1" },
        { id: "a", at: "1" },
      ],
      /not in strictly ascending key order/,
    ],
    [
      "outside the range",
      () => [{ id: "z", at: "9" }],
      /outside the range asked/,
    ],
    [
      "a key of the wrong arity",
      () => [{ id: "a", at: "1", bad: true }],
      /must be 1 text \(or null\) part/,
    ],
    ["a non-string id", () => [{ id: 7, at: "1" }], /not a string/],
  ])("an answer %s fails the page loudly", async (_name, answer, message) => {
    const v = liveValue(key("paged-check"), {
      query: Selector,
      paged: {
        item: Item,
        id: "id",
        // `bad` items answer a key of two parts.
        key: {
          of: (i: Item) =>
            (i as Item & { bad?: true }).bad ? [i.at, "x"] : [i.at],
          order: ["desc"],
        },
        limit: 2,
        maxLimit: 4,
      },
    });
    const compiled = compilePagedValue(v, {
      source: "external",
      changes: "notified",
      loader: (_q, range) => answer(range) as Item[],
    });
    const params = v.query.encode({ metric: "m" }, page('["5","e"]', null));
    const failure = await Promise.resolve(compiled.options.loader(params)).then(
      () => null,
      (err: unknown) => err,
    );
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(message);
  });

  test("a $key over LIVE_ROW_KEY_MAX_BYTES is minted null", async () => {
    const v = bareValue("paged-long");
    const long = "x".repeat(LIVE_ROW_KEY_MAX_BYTES);
    const compiled = compilePagedValue(v, {
      source: "external",
      changes: "notified",
      loader: () => [
        { id: "a", at: long },
        { id: "b", at: "short" },
      ],
    });
    const rows: unknown = await compiled.options.loader(
      v.query.encode({ metric: "m" }, page(null, null)),
    );
    expect(rows).toEqual([
      { id: "a", at: long, $key: null },
      { id: "b", at: "short", $key: '["short","b"]' },
    ]);
  });

  test("the meta sibling: its loader gets the question, and it is registered beside the pages", async () => {
    const h = harness();
    const v = pagedValue("paged-meta");
    const { meta } = registerPagedValue(h.runtime, v, {
      source: "external",
      changes: "notified",
      loader: () => [],
      meta: (q) => ({ total: q.metric.length }),
    });
    expect(meta?.resource.key).toBe(`${v.key}:meta`);
    const tuple = v.meta.query.encode({ metric: "abc" });
    await h.subscribe(v.meta.key, tuple);
    const ack = h.frames.find(
      (f) => f.kind === "sub-ack" && f.key === v.meta.key,
    );
    expect(ack?.value).toEqual({ total: 3 });
  });

  test("a page compiles to a keyed external window: its size and family off the page codec", () => {
    const v = bareValue("paged-window");
    const compiled = compilePagedValue(v, {
      source: "external",
      changes: "notified",
      loader: () => [],
    });
    const { membership } = compiled.options;
    const head = v.query.encode({ metric: "m" }, page(null, '["5","e"]', 4));
    const tail = v.query.encode({ metric: "m" }, page('["5","e"]', null, 3));
    const other = v.query.encode({ metric: "x" }, page(null, null));
    expect("mode" in compiled.options).toBe(false);
    expect(membership.kind).toBe("window");
    expect(membership.limitOf(head)).toBe(4);
    expect(membership.limitOf(tail)).toBe(3);
    // One family per question, whatever the range and limit.
    expect(membership.familyOf!(head)).toBe(membership.familyOf!(tail));
    expect(membership.familyOf!(head)).not.toBe(membership.familyOf!(other));
    expect(v.keyed.keyOf({ id: "a", at: "1", $key: null })).toBe("a");
  });

  test("notify(q) reaches every subscribed page of that question and its meta, and none of another", async () => {
    const h = harness();
    const v = pagedValue("paged-notify");
    let loads = 0;
    const { resource, compiled, meta } = registerPagedValue(h.runtime, v, {
      source: "external",
      changes: "notified",
      // A fresh answer each load (an unchanged one pushes nothing).
      loader: (_q, range) => [
        { id: `n${++loads}`, at: range.after === null ? "9" : "1" },
      ],
      meta: () => ({ total: ++loads }),
    });
    const p0 = v.query.encode({ metric: "m" }, page(null, '["5","e"]'));
    const p1 = v.query.encode({ metric: "m" }, page('["5","e"]', null));
    const other = v.query.encode({ metric: "x" }, page(null, null));
    const m = v.meta.query.encode({ metric: "m" });
    await h.subscribe(v.key, p0);
    await h.subscribe(v.key, p1);
    await h.subscribe(v.key, other);
    await h.subscribe(v.meta.key, m);
    expect(compiled.tuplesOf({ metric: "m" })).toEqual([p0, p1]);
    expect(compiled.meta?.tuplesOf({ metric: "m" })).toEqual([m]);
    expect(compiled.meta?.tuplesOf({ metric: "x" })).toEqual([]);
    for (const t of compiled.tuplesOf({ metric: "m" })) resource.notify(t);
    for (const t of compiled.meta!.tuplesOf({ metric: "m" })) {
      meta!.resource.notify(t);
    }
    // A page is a keyed window: its re-read ships a keyed delta.
    await h.until(() => h.of("delta", v.key).length >= 2, "deltas");
    await sleep(20);
    expect(h.of("delta", v.key).map((f) => f.params)).toEqual([p0, p1]);
    expect(h.of("update", v.key)).toEqual([]);
    expect(h.of("update", v.meta.key).map((f) => f.params)).toEqual([m]);
    // Unsubscribed pages are forgotten.
    h.unsubscribe(v.key, p1);
    expect(compiled.tuplesOf({ metric: "m" })).toEqual([p0]);
  });

  test("whileSubscribed runs once per QUESTION, over its pages and its meta; its notify reaches them all", async () => {
    const h = harness();
    const v = pagedValue("paged-life");
    const log: string[] = [];
    let notify: (() => void) | undefined;
    let loads = 0;
    registerPagedValue(h.runtime, v, {
      source: "external",
      changes: "notified",
      // A fresh answer each load (an unchanged one pushes nothing).
      loader: (_q, range) => [
        { id: `n${++loads}`, at: range.after === null ? "9" : "1" },
      ],
      meta: () => ({ total: ++loads }),
      whileSubscribed: (q, n) => {
        log.push(`start ${q.metric}`);
        notify = n;
        return () => log.push(`stop ${q.metric}`);
      },
    });
    const p0 = v.query.encode({ metric: "m" }, page(null, '["5","e"]'));
    const p1 = v.query.encode({ metric: "m" }, page('["5","e"]', null));
    const m = v.meta.query.encode({ metric: "m" });
    await h.subscribe(v.key, p0);
    await h.subscribe(v.key, p1);
    await h.subscribe(v.meta.key, m);
    expect(log).toEqual(["start m"]);
    notify!();
    await h.until(
      () =>
        h.of("delta", v.key).length >= 2 &&
        h.of("update", v.meta.key).length >= 1,
      "deltas and the meta's update",
    );
    // A page released, another minted: the question is still held.
    h.unsubscribe(v.key, p1);
    await sleep(5);
    h.unsubscribe(v.key, p0);
    await sleep(5);
    expect(log).toEqual(["start m"]);
    h.unsubscribe(v.meta.key, m);
    await sleep(5);
    expect(log).toEqual(["start m", "stop m"]);
  });

  test("a page subscribed while its question's async start resolves waits for it too", async () => {
    const v = pagedValue("paged-async-life");
    const log: string[] = [];
    let resolveStart: ((stop: StopFn) => void) | undefined;
    const compiled = compilePagedValue(v, {
      source: "external",
      changes: "notified",
      loader: () => [],
      meta: () => ({ total: 0 }),
      whileSubscribed: (q) =>
        new Promise<StopFn>((resolve) => {
          log.push(`start ${q.metric}`);
          resolveStart = resolve;
        }),
    });
    compiled.bindNotify(() => {});
    compiled.meta!.bindNotify(() => {});
    const p0 = v.query.encode({ metric: "m" }, page(null, '["5","e"]'));
    const p1 = v.query.encode({ metric: "m" }, page('["5","e"]', null));
    // Drive the hooks directly: the runtime awaits each before the tuple's read.
    const first = compiled.options.onFirstSubscribe!(p0);
    const second = compiled.options.onFirstSubscribe!(p1);
    expect(first).toBeInstanceOf(Promise);
    expect(second).toBeInstanceOf(Promise);
    let secondSettled = false;
    void (second as Promise<void>).then(() => (secondSettled = true));
    await sleep(0);
    expect(secondSettled).toBe(false);
    resolveStart!(() => log.push("stop m"));
    await first;
    await second;
    expect(secondSettled).toBe(true);
    expect(log).toEqual(["start m"]);
    // Once started, a further page of it is read at once.
    const p2 = v.query.encode({ metric: "m" }, page('["3","c"]', null));
    expect(compiled.options.onFirstSubscribe!(p2)).toBeUndefined();
  });

  test("a meta loader is required with paged.meta, and refused without it", () => {
    expect(() =>
      compilePagedValue(pagedValue("paged-no-meta"), {
        source: "external",
        changes: "notified",
        loader: () => [],
      } as never),
    ).toThrow(/serve it with `meta\(query\)`/);
    expect(() =>
      compilePagedValue(bareValue("paged-stray-meta"), {
        source: "external",
        changes: "notified",
        loader: () => [],
        meta: () => ({}),
      } as never),
    ).toThrow(/only for a value declared `paged.meta`/);
  });

  test("types: a paged value is external only; the loader answers items, never a cursor page", () => {
    const v = bareValue("t-paged");
    const typeOnly = () => {
      compilePagedValue(v, {
        // @ts-expect-error — a paged Postgres list is a liveCollection
        source: "db",
        loader: () => [],
      });
      compilePagedValue(v, {
        source: "external",
        changes: "notified",
        // @ts-expect-error — the cursor page is gone: a loader answers its range's items
        loader: () => ({ items: [], nextCursor: null }),
      });
      compilePagedValue(pagedValue("t-paged-meta"), {
        source: "external",
        changes: "notified",
        loader: () => [],
        // @ts-expect-error — the meta answers its declared schema
        meta: () => ({ count: 1 }),
      });
      // @ts-expect-error — declared `paged.meta`, the meta is served
      compilePagedValue(pagedValue("t-paged-no-meta"), {
        source: "external",
        changes: "notified",
        loader: () => [],
      });
    };
    expect(typeof typeOnly).toBe("function");
  });
});
