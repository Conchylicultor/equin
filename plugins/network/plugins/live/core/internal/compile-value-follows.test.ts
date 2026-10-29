/**
 * `follows` in the shared compile (research/2026-10-24-global-live-narrowed-reads.md
 * §1, §3 R2) — host-agnostic: a fake followable source stands for a served
 * collection (the Bun host's `serveCollection` puts the real one on its
 * handle, and compiles the routes — pinned by `live/server`'s
 * `serve-value-follows-oracle.test.ts`). Pinned here:
 *
 * - `{ followed }` reaches every hook — the loader, `revalidate`,
 *   `whileFollowing` (db and external, with `notify`), a paged value's loader
 *   and `meta` — read fresh in that call;
 * - `whileSubscribed` beside follows is handed the subject (and `notify`)
 *   only and is never re-started by a moved row; declared with
 *   `whileFollowing`, both start and stop with the tuple (`bothLifecycles`),
 *   and one start failing does not keep the other from starting;
 * - the follow lifecycle (`followLifecycle`): a start re-points only when the
 *   followed rows moved and the tuple is still in its span; re-points run in
 *   order; a stop before a start resolved never leaks; a stop during a
 *   re-point stops the new start; untracked reads start nothing; driven end
 *   to end by the runtime's `onFollowReached` through a follow route;
 * - the refusals (a follow on a silent external value, an empty `follows`, a
 *   non-target, `whileFollowing` without follows), and the types (a non-target and a wrong tuple shape are
 *   errors; `followed` is typed per name).
 */

import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  createResourceRuntime,
  mintReachPlan,
  type ResourceParams,
  type TupleUse,
} from "@plugins/framework/plugins/resource-runtime/core";
import { liveValue } from "@plugins/network/plugins/live/core";
import {
  bothLifecycles,
  compilePagedValue,
  compileValue,
  followLifecycle,
  pairLifecycle,
  type StopFn,
} from "./compile-value";
import {
  FOLLOW_SOURCE,
  type FollowIds,
  type FollowIdsTarget,
  type FollowWhere,
  type FollowWhereTarget,
} from "./follows";

const Count = z.object({ n: z.number() });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let seq = 0;
const key = (name: string) => `test.follows.${name}.${seq++}`;

interface Ws {
  id: string;
  path: string;
}

/** A fake `:rows` source over an in-memory table, counting its reads. */
function idsTarget(rows: Map<string, Ws>) {
  const reads: string[][] = [];
  const target: FollowIdsTarget<Ws> = {
    [FOLLOW_SOURCE]: {
      form: "ids",
      collection: "test.ws:rows",
      read: ({ ids }: FollowIds) => {
        reads.push([...ids]);
        return Promise.resolve(
          ids.flatMap((id) => {
            const row = rows.get(id);
            return row === undefined ? [] : [{ ...row }];
          }),
        );
      },
      reach: () => {
        throw new Error("no host compile in a core test");
      },
      deferred: false,
    },
  };
  return { target, reads };
}

/** A fake scoped `all` source by `attemptId`. */
function whereTarget(rows: { id: string; attemptId: string }[]) {
  const target: FollowWhereTarget<{ id: string }, "attemptId"> = {
    [FOLLOW_SOURCE]: {
      form: "where",
      collection: "test.convs",
      read: ({ where }: FollowWhere<"attemptId">) =>
        Promise.resolve(
          rows
            .filter((r) => r.attemptId === where.attemptId)
            .map((r) => ({ id: r.id })),
        ),
      reach: () => {
        throw new Error("no host compile in a core test");
      },
      deferred: false,
    },
  };
  return target;
}

describe("{ followed } reaches every hook, read fresh", () => {
  test("loader and revalidate: the rows of the tuple, at the time of the call", async () => {
    const rows = new Map([["c1", { id: "c1", path: "/a" }]]);
    const { target, reads } = idsTarget(rows);
    const v = liveValue(key("loader"), { schema: Count, params: ["id"] });
    const seen: string[] = [];
    const compiled = compileValue(v, {
      source: "db",
      follows: (follow) => ({
        ws: follow(target, ({ id }) => ({ ids: [id] })),
      }),
      loader: ({ id }, { followed }) => {
        seen.push(`${id}:${followed.ws.map((r) => r.path).join()}`);
        return { n: followed.ws.length };
      },
      revalidate: (_p, { followed }) =>
        Promise.resolve(`etag:${followed.ws[0]?.path}`),
    });
    expect(await compiled.options.loader({ id: "c1" })).toEqual({ n: 1 });
    rows.set("c1", { id: "c1", path: "/b" });
    expect(await compiled.options.loader({ id: "c1" })).toEqual({ n: 1 });
    expect(seen).toEqual(["c1:/a", "c1:/b"]);
    expect(await compiled.options.revalidate!({ id: "c1" })).toBe("etag:/b");
    expect(reads).toEqual([["c1"], ["c1"], ["c1"]]);
  });

  test("an empty id set reads nothing and is handed none", async () => {
    const { target, reads } = idsTarget(new Map());
    const v = liveValue(key("empty"), { schema: Count, params: ["id"] });
    const compiled = compileValue(v, {
      source: "db",
      follows: (follow) => ({ ws: follow(target, () => ({ ids: [] })) }),
      loader: (_p, { followed }) => ({ n: followed.ws.length }),
    });
    expect(await compiled.options.loader({ id: "x" })).toEqual({ n: 0 });
    expect(reads).toEqual([]);
  });

  test("whileFollowing: db gets { followed }, external { followed, notify }", async () => {
    const rows = new Map([["c1", { id: "c1", path: "/a" }]]);
    const { target } = idsTarget(rows);
    const log: string[] = [];
    const db = compileValue(
      liveValue(key("ws-db"), { schema: Count, params: ["id"] }),
      {
        source: "db",
        follows: (follow) => ({
          ws: follow(target, ({ id }) => ({ ids: [id] })),
        }),
        loader: () => ({ n: 0 }),
        whileFollowing: {
          over: (followed) => followed.ws[0]!.path,
          start: ({ id }, { over: path }): StopFn => {
            log.push(`db ${id} ${path}`);
            return () => {};
          },
        },
      },
    );
    await db.options.onFirstSubscribe!({ id: "c1" });
    let notified = 0;
    const ext = compileValue(
      liveValue(key("ws-ext"), { schema: Count, params: ["id"] }),
      {
        source: "external",
        changes: "notified",
        follows: (follow) => ({
          ws: follow(target, ({ id }) => ({ ids: [id] })),
        }),
        loader: () => ({ n: 0 }),
        whileFollowing: {
          over: (followed) => followed.ws[0]!.path,
          start: ({ id }, { over: path, notify }): StopFn => {
            log.push(`ext ${id} ${path}`);
            notify();
            return () => {};
          },
        },
      },
    );
    ext.bindNotify(() => notified++);
    await ext.options.onFirstSubscribe!({ id: "c1" });
    expect(log).toEqual(["db c1 /a", "ext c1 /a"]);
    expect(notified).toBe(1);
  });

  test("a paged value: the page loader and meta get the question's rows", async () => {
    const target = whereTarget([
      { id: "c1", attemptId: "a" },
      { id: "c2", attemptId: "a" },
      { id: "c3", attemptId: "b" },
    ]);
    const v = liveValue(key("paged"), {
      query: z.object({ attemptId: z.string() }),
      paged: {
        item: z.object({ id: z.string() }),
        id: "id",
        key: { of: (i: { id: string }) => [i.id], order: ["asc"] as const },
        limit: 5,
        maxLimit: 10,
        meta: z.object({ total: z.number() }),
      },
    });
    const compiled = compilePagedValue(v, {
      source: "external",
      changes: "notified",
      follows: (follow) => ({
        convs: follow(target, ({ attemptId }) => ({ where: { attemptId } })),
      }),
      loader: (_q, _range, { followed }) =>
        followed.convs.map((c) => ({ id: c.id })),
      meta: (_q, { followed }) => ({ total: followed.convs.length }),
    });
    const params = v.query.encode(
      { attemptId: "a" },
      { after: null, until: null, limit: 5 },
    );
    const page = await compiled.options.loader(params);
    expect((page as { id: string }[]).map((r) => r.id)).toEqual(["c1", "c2"]);
    expect(
      await compiled.meta!.options.loader({
        q: v.query.encodeQuery({ attemptId: "a" }),
      }),
    ).toEqual({ total: 2 });
  });
});

describe("followLifecycle — a start follows the rows it was handed", () => {
  function lifecycle(initial: string) {
    let path = initial;
    const log: string[] = [];
    const life = followLifecycle<{ id: string }, string>(
      ({ id }, followed) => {
        log.push(`start ${id} ${followed}`);
        return () => log.push(`stop ${id} ${followed}`);
      },
      () => Promise.resolve(path),
    );
    return {
      life,
      log,
      move: (to: string) => {
        path = to;
      },
    };
  }

  test("re-points only when the rows moved; re-points run in order", async () => {
    const { life, log, move } = lifecycle("/a");
    await life.onFirstSubscribe({ id: "c" });
    expect(await life.onFollowReached({ id: "c" })).toBe("unchanged");
    move("/b");
    const one = life.onFollowReached({ id: "c" });
    const two = life.onFollowReached({ id: "c" });
    expect(await one).toBe("repointed");
    expect(await two).toBe("unchanged");
    expect(log).toEqual(["start c /a", "stop c /a", "start c /b"]);
    life.onLastUnsubscribe({ id: "c" });
    await sleep(0);
    expect(log.at(-1)).toBe("stop c /b");
  });

  test("an untracked tuple, or one released, never starts", async () => {
    const { life, log, move } = lifecycle("/a");
    expect(await life.onFollowReached({ id: "c" })).toBe("unchanged");
    await life.onFirstSubscribe({ id: "c" });
    life.onLastUnsubscribe({ id: "c" });
    move("/b");
    expect(await life.onFollowReached({ id: "c" })).toBe("unchanged");
    await sleep(0);
    expect(log).toEqual(["start c /a", "stop c /a"]);
  });

  test("a stop during a re-point stops the new start; a new span is its own", async () => {
    let path = "/a";
    let gate: (() => void) | undefined;
    const log: string[] = [];
    const life = followLifecycle<{ id: string }, string>(
      (_p, followed) => {
        log.push(`start ${followed}`);
        return () => log.push(`stop ${followed}`);
      },
      async () => {
        const at = path;
        if (gate === undefined && at === "/b") {
          await new Promise<void>((r) => {
            gate = r;
          });
        }
        return at;
      },
    );
    await life.onFirstSubscribe({ id: "c" });
    path = "/b";
    const repoint = life.onFollowReached({ id: "c" });
    await sleep(0);
    // Released while the re-point reads: it must start nothing.
    life.onLastUnsubscribe({ id: "c" });
    gate!();
    expect(await repoint).toBe("unchanged");
    await sleep(0);
    expect(log).toEqual(["start /a", "stop /a"]);
    // A new span reads afresh.
    await life.onFirstSubscribe({ id: "c" });
    expect(log.at(-1)).toBe("start /b");
  });

  test("a stop before the first start resolved runs once it resolves", async () => {
    let resolveStart: ((stop: StopFn) => void) | undefined;
    const log: string[] = [];
    const life = followLifecycle<{ id: string }, string>(
      () =>
        new Promise<StopFn>((resolve) => {
          log.push("start");
          resolveStart = resolve;
        }),
      () => Promise.resolve("/a"),
    );
    const started = life.onFirstSubscribe({ id: "c" });
    await sleep(0);
    life.onLastUnsubscribe({ id: "c" });
    resolveStart!(() => log.push("stop"));
    await started;
    await sleep(0);
    expect(log).toEqual(["start", "stop"]);
  });

  test("a start that failed is retried by the next reach, whether or not the rows moved", async () => {
    let fail = true;
    const log: string[] = [];
    const life = followLifecycle<{ id: string }, string>(
      (_p, over) => {
        if (fail) throw new Error(`open ${over} failed`);
        log.push(`start ${over}`);
        return () => log.push(`stop ${over}`);
      },
      () => Promise.resolve("/a"),
    );
    const first = await (
      life.onFirstSubscribe({ id: "c" }) as Promise<void>
    ).then(
      () => null,
      (err: unknown) => err,
    );
    expect((first as Error).message).toBe("open /a failed");
    // The rows did not move, and the watch is not open: the reach starts it.
    fail = false;
    expect(await life.onFollowReached({ id: "c" })).toBe("repointed");
    expect(await life.onFollowReached({ id: "c" })).toBe("unchanged");
    life.onLastUnsubscribe({ id: "c" });
    await sleep(0);
    expect(log).toEqual(["start /a", "stop /a"]);
  });

  test("reaches arriving while a re-point is queued join it: one read, one re-point", async () => {
    let path = "/a";
    let reads = 0;
    let gate: (() => void) | undefined;
    const log: string[] = [];
    const life = followLifecycle<{ id: string }, string>(
      (_p, over) => {
        log.push(`start ${over}`);
        return () => log.push(`stop ${over}`);
      },
      async () => {
        reads++;
        if (path === "/b" && gate === undefined) {
          await new Promise<void>((r) => {
            gate = r;
          });
        }
        return path;
      },
    );
    await life.onFirstSubscribe({ id: "q" });
    path = "/b";
    // The first re-point is READING (held): a reach now queues behind it,
    // and the reaches after that join the queued one (K pages + the meta).
    const reading = life.onFollowReached({ id: "q" });
    await sleep(0);
    const queued = life.onFollowReached({ id: "q" });
    const joined = [
      life.onFollowReached({ id: "q" }),
      life.onFollowReached({ id: "q" }),
    ];
    gate!();
    expect(await reading).toBe("repointed");
    expect(await queued).toBe("unchanged");
    expect(await Promise.all(joined)).toEqual(["unchanged", "unchanged"]);
    // The first start's read, the reading re-point's, and ONE for the rest.
    expect(reads).toBe(3);
    expect(log).toEqual(["start /a", "stop /a", "start /b"]);
  });

  test("over: a start re-points only when what it reads moves, never on rows it ignores", async () => {
    const rows = new Map([["c1", { id: "c1", path: "/a" }]]);
    const { target } = idsTarget(rows);
    const convs = [{ id: "x", attemptId: "c1" }];
    const v = liveValue(key("over"), { schema: Count, params: ["id"] });
    const log: string[] = [];
    const compiled = compileValue(v, {
      source: "db",
      follows: (follow) => ({
        ws: follow(target, ({ id }) => ({ ids: [id] })),
        convs: follow(whereTarget(convs), ({ id }) => ({
          where: { attemptId: id },
        })),
      }),
      loader: (_p, { followed }) => ({ n: followed.convs.length }),
      whileFollowing: {
        over: (followed) => followed.ws[0]?.path ?? null,
        start: (_p, { over: path }): StopFn => {
          log.push(`watch ${path}`);
          return () => log.push(`unwatch ${path}`);
        },
      },
    });
    const life = compiled.options as Required<
      Pick<
        typeof compiled.options,
        "onFirstSubscribe" | "onLastUnsubscribe" | "onFollowReached"
      >
    >;
    await life.onFirstSubscribe({ id: "c1" });
    // A conversation joins: the followed rows moved, the path did not.
    convs.push({ id: "y", attemptId: "c1" });
    expect(await life.onFollowReached({ id: "c1" })).toBe("unchanged");
    rows.set("c1", { id: "c1", path: "/b" });
    expect(await life.onFollowReached({ id: "c1" })).toBe("repointed");
    expect(log).toEqual(["watch /a", "unwatch /a", "watch /b"]);
  });

  test("end to end: a follow route reaching a tracked tuple re-points its watch; an untracked read starts nothing", async () => {
    const runtime = createResourceRuntime();
    const handler = runtime.notificationsWsHandler as unknown as {
      open(ws: unknown): void;
      message(ws: unknown, raw: string): void;
    };
    const ws = { send() {} };
    handler.open(ws);
    const rows = new Map([["c1", { id: "c1", path: "/a" }]]);
    const { target } = idsTarget(rows);
    const v = liveValue(key("e2e"), { schema: Count, params: ["id"] });
    const log: string[] = [];
    const compiled = compileValue(v, {
      source: "external",
      changes: "notified",
      follows: (follow) => ({
        ws: follow(target, ({ id }) => ({ ids: [id] })),
      }),
      loader: () => ({ n: 1 }),
      whileFollowing: {
        over: (followed) => followed.ws[0]?.path ?? null,
        start: ({ id }, { over: path }): StopFn => {
          log.push(`watch ${id} ${path}`);
          return () => log.push(`unwatch ${id} ${path}`);
        },
      },
    });
    // The reach the Bun host would compile for this follow.
    const reach = mintReachPlan<ResourceParams>({
      routes: [
        {
          id: "ws:base",
          table: "conversations",
          map: { kind: "full", reason: "follow" },
          columns: ["attempt_id", "id"],
          match: ["id"],
          via: { name: "ws", collection: "test.ws:rows" },
        },
      ],
      usesOf: (p) =>
        new Map<string, TupleUse>([
          ["ws:base", { role: "membership", match: { id: new Set([p.id!]) } }],
        ]),
    });
    const resource = runtime.defineExternalResource(v, {
      ...compiled.options,
      reach,
    });
    compiled.bindNotify((p) => resource.notify(p));
    await runtime.loadResourceByKey(v.key, { id: "c1" });
    expect(log).toEqual([]);
    handler.message(
      ws,
      JSON.stringify({ op: "sub", key: v.key, params: { id: "c1" } }),
    );
    await sleep(20);
    expect(log).toEqual(["watch c1 /a"]);
    rows.set("c1", { id: "c1", path: "/b" });
    runtime.routeTableChange({
      source: "feed",
      table: "conversations",
      op: "U",
      ids: ["c1"],
      keys: { id: ["c1"] },
      unchanged: [],
    });
    await sleep(20);
    expect(log).toEqual(["watch c1 /a", "unwatch c1 /a", "watch c1 /b"]);
  });
});

describe("whileSubscribed beside follows — never re-pointed", () => {
  test("end to end: a moved row re-points whileFollowing only; both stop on the last unsubscribe", async () => {
    const runtime = createResourceRuntime();
    const handler = runtime.notificationsWsHandler as unknown as {
      open(ws: unknown): void;
      message(ws: unknown, raw: string): void;
    };
    const ws = { send() {} };
    handler.open(ws);
    const rows = new Map([["c1", { id: "c1", path: "/a" }]]);
    const { target } = idsTarget(rows);
    const v = liveValue(key("both"), { schema: Count, params: ["id"] });
    const log: string[] = [];
    let notified = 0;
    const compiled = compileValue(v, {
      source: "external",
      changes: "notified",
      follows: (follow) => ({
        ws: follow(target, ({ id }) => ({ ids: [id] })),
      }),
      loader: () => ({ n: 1 }),
      whileSubscribed: ({ id }, notify): StopFn => {
        log.push(`memo ${id}`);
        notify();
        return () => log.push(`evict ${id}`);
      },
      whileFollowing: {
        over: (followed) => followed.ws[0]?.path ?? null,
        start: ({ id }, { over: path }): StopFn => {
          log.push(`watch ${id} ${path}`);
          return () => log.push(`unwatch ${id} ${path}`);
        },
      },
    });
    const reach = mintReachPlan<ResourceParams>({
      routes: [
        {
          id: "ws:base",
          table: "conversations",
          map: { kind: "full", reason: "follow" },
          columns: ["attempt_id", "id"],
          match: ["id"],
          via: { name: "ws", collection: "test.ws:rows" },
        },
      ],
      usesOf: (p) =>
        new Map<string, TupleUse>([
          ["ws:base", { role: "membership", match: { id: new Set([p.id!]) } }],
        ]),
    });
    const resource = runtime.defineExternalResource(v, {
      ...compiled.options,
      reach,
    });
    compiled.bindNotify((p) => {
      notified++;
      resource.notify(p);
    });
    handler.message(
      ws,
      JSON.stringify({ op: "sub", key: v.key, params: { id: "c1" } }),
    );
    await sleep(20);
    expect(log).toEqual(["memo c1", "watch c1 /a"]);
    expect(notified).toBe(1);
    rows.set("c1", { id: "c1", path: "/b" });
    runtime.routeTableChange({
      source: "feed",
      table: "conversations",
      op: "U",
      ids: ["c1"],
      keys: { id: ["c1"] },
      unchanged: [],
    });
    await sleep(20);
    expect(log).toEqual([
      "memo c1",
      "watch c1 /a",
      "unwatch c1 /a",
      "watch c1 /b",
    ]);
    handler.message(
      ws,
      JSON.stringify({ op: "unsub", key: v.key, params: { id: "c1" } }),
    );
    await sleep(20);
    expect(log.slice(4).sort()).toEqual(["evict c1", "unwatch c1 /b"]);
  });

  test("bothLifecycles: a start that fails does not keep the other from starting, and is reported", async () => {
    const log: string[] = [];
    const life = bothLifecycles<{ id: string }>(
      pairLifecycle(() => {
        throw new Error("memo failed");
      }),
      followLifecycle<{ id: string }, string>(
        (_p, followed) => {
          log.push(`start ${followed}`);
          return () => log.push(`stop ${followed}`);
        },
        () => Promise.resolve("/a"),
      ),
    )!;
    const started = life.onFirstSubscribe({ id: "c" });
    expect(started).toBeInstanceOf(Promise);
    const failure = await (started as Promise<void>).then(
      () => null,
      (err: unknown) => err,
    );
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(/memo failed/);
    expect(log).toEqual(["start /a"]);
    life.onLastUnsubscribe({ id: "c" });
    await sleep(0);
    expect(log).toEqual(["start /a", "stop /a"]);
  });

  test("bothLifecycles: two sync starts stay sync; one hook alone is passed through", () => {
    const sync = pairLifecycle<{ id: string }>(() => () => {});
    const follower = followLifecycle<{ id: string }, string>(
      () => () => {},
      () => Promise.resolve("/a"),
    );
    expect(bothLifecycles(sync, undefined)).toBe(sync);
    expect(bothLifecycles(undefined, follower)).toBe(follower);
    expect(bothLifecycles(undefined, undefined)).toBeUndefined();
    expect(
      bothLifecycles(
        sync,
        pairLifecycle<{ id: string }>(() => () => {}) as never,
      )!.onFirstSubscribe({ id: "c" }),
    ).toBeUndefined();
  });
});

describe("bothLifecycles — a throwing stop", () => {
  test("a whileSubscribed stop that throws still stops the whileFollowing start", async () => {
    const log: string[] = [];
    const life = bothLifecycles<{ id: string }>(
      pairLifecycle(() => () => {
        throw new Error("evict failed");
      }),
      followLifecycle<{ id: string }, string>(
        (_p, over) => {
          log.push(`start ${over}`);
          return () => log.push(`stop ${over}`);
        },
        () => Promise.resolve("/a"),
      ),
    )!;
    await life.onFirstSubscribe({ id: "c" });
    expect(() => life.onLastUnsubscribe({ id: "c" })).toThrow(/evict failed/);
    await sleep(0);
    expect(log).toEqual(["start /a", "stop /a"]);
  });
});

describe("refusals and types", () => {
  test("a silent external value takes no follows; an empty follows and a non-target are refused", () => {
    const { target } = idsTarget(new Map());
    const v = liveValue(key("silent"), { schema: Count, params: ["id"] });
    expect(() =>
      compileValue(v, {
        source: "external",
        changes: { fixed: { reason: "r" } },
        // @ts-expect-error — a value with no change signal follows nothing
        follows: (follow) => ({
          ws: follow(target, ({ id }: { id: string }) => ({ ids: [id] })),
        }),
        loader: () => ({ n: 0 }),
      }),
    ).toThrow(/reacts to a change signal/);
    expect(() =>
      compileValue(v, {
        source: "db",
        follows: () => ({}),
        loader: () => ({ n: 0 }),
      }),
    ).toThrow(/names no follow/);
    expect(() =>
      compileValue(v, {
        source: "db",
        follows: (follow) => ({
          // @ts-expect-error — a value descriptor is no follow target
          ws: follow(v, () => ({ ids: [] })),
        }),
        loader: () => ({ n: 0 }),
      }),
    ).toThrow(/no served collection's followable read/);
    expect(() =>
      compileValue(v, {
        source: "db",
        loader: () => ({ n: 0 }),
        whileFollowing: {
          over: () => null,
          // @ts-expect-error — no follows: no rows to start over
          start: () => () => {},
        },
      }),
    ).toThrow(/declares no `follows`/);
  });

  test("types: the tuple's form is the target's, and followed is typed per name", () => {
    const { target } = idsTarget(new Map());
    const where = whereTarget([]);
    const v = liveValue(key("types"), { schema: Count, params: ["id"] });
    // Never called — the assertions are the `@ts-expect-error`s.
    const typeOnly = () => {
      compileValue(v, {
        source: "db",
        follows: (follow) => ({
          // @ts-expect-error — a `:rows` set is followed by `{ ids }`
          ws: follow(target, ({ id }) => ({ where: { id } })),
          // @ts-expect-error — the scope is exactly the set's `by`
          convs: follow(where, ({ id }) => ({ where: { pageId: id } })),
        }),
        loader: () => ({ n: 0 }),
      });
      compileValue(v, {
        source: "db",
        follows: (follow) => ({
          // @ts-expect-error — `ids` is a list
          ws: follow(target, ({ id }) => ({ ids: id })),
        }),
        loader: () => ({ n: 0 }),
      });
      compileValue(v, {
        source: "db",
        follows: (follow) => ({
          ws: follow(target, ({ id }) => ({ ids: [id] })),
          convs: follow(where, ({ id }) => ({ where: { attemptId: id } })),
        }),
        loader: (_p, { followed }) => {
          const paths: readonly string[] = followed.ws.map((r) => r.path);
          const ids: readonly string[] = followed.convs.map((c) => c.id);
          // @ts-expect-error — no follow of that name
          void followed.other;
          return { n: paths.length + ids.length };
        },
      });
      compileValue(v, {
        source: "db",
        follows: (follow) => ({
          ws: follow(target, ({ id }) => ({ ids: [id] })),
        }),
        loader: () => ({ n: 0 }),
        // @ts-expect-error — `whileSubscribed` is handed no rows (that is `whileFollowing`)
        whileSubscribed: (_p, _ctx: { followed: unknown }) => () => {},
      });
      compileValue(v, {
        source: "db",
        follows: (follow) => ({
          ws: follow(target, ({ id }) => ({ ids: [id] })),
        }),
        loader: () => ({ n: 0 }),
        whileFollowing: {
          over: (followed) => followed.ws.map((r) => r.path),
          start: (_p, ctx) => {
            const paths: readonly string[] = ctx.over;
            // @ts-expect-error — the start is handed what `over` read, never the rows
            void ctx.followed;
            return () => void paths;
          },
        },
      });
    };
    expect(typeof typeOnly).toBe("function");
  });
});
