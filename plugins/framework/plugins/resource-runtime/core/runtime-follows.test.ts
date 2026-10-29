/**
 * Follows (research/2026-10-24-global-live-narrowed-reads.md §2–§3): a value
 * reading collection tuples carries the collections' routes in its reach
 * plan, tagged `via` the follow (`Route.via`). Pinned here:
 *
 * - minting: a follow owns its tables (no own route, unfed, relation,
 *   notified or tagged read beside it; one follow name reads one
 *   collection), and a keyed `RoutePlan` holds no follow route;
 * - A8: the follower's OWN capture never covers a followed table (a read by
 *   hand is drift — thrown under `strictRoutes`, failed open in a server); a
 *   run that read nothing is judged as nothing; a persisted `tables_read`
 *   judges a followed table by its name;
 * - a view read whole over a followed table is refused once bases are known;
 * - R1: a paged value's page (an external keyed window) reached through a
 *   follow route re-reads only the question whose tuple matched;
 * - R2: `onFollowReached` fires for TRACKED tuples a follow route lets the
 *   change through to — in push and invalidate modes, synchronously from the
 *   router, outside any flight, in a `bg` origin — and `_debug` lists the
 *   follows and counts `"repointed"` answers; it is refused without a follow
 *   route;
 * - `loadResourceFresh`: the entry's own loader in its own loader span, never
 *   joining an in-flight read.
 */

import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  mintReachPlan,
  mintRoutePlan,
  type FullRoute,
  type TableChange,
  type TupleUse,
} from "./routing";
import {
  controllable,
  createHarness,
  tick,
  type Harness,
} from "./test-support";
import type { ResourceParams } from "./runtime";

/** Await `p` and return the Error it rejected with; throw if it resolved. */
async function rejection(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (err) {
    return err as Error;
  }
  throw new Error("expected the promise to reject, but it resolved");
}

const settle = async () => {
  await tick();
  await tick();
};

const VIA = { name: "ws", collection: "conv-ws:rows" };

/**
 * The reach a follower of a `:rows` lookup over `conversations` (joined to
 * `attempts`) compiles to: the key table matched per tuple on `id`, gated;
 * the far side gated, unmatched — both tagged `via` the follow.
 */
function followReach(
  conv: (p: ResourceParams) => string = (p) => p.conv!,
  extra: { own?: FullRoute[] } = {},
) {
  const reason = "the follow re-reads its follower whole";
  return mintReachPlan<ResourceParams>({
    routes: [
      ...(extra.own ?? []),
      {
        id: "ws:base",
        table: "conversations",
        map: { kind: "full", reason },
        columns: ["attempt_id", "id"],
        match: ["id"],
        via: VIA,
      },
      {
        id: "ws:attempt",
        table: "attempts",
        map: { kind: "full", reason },
        columns: ["id", "worktree_path"],
        via: VIA,
      },
    ],
    usesOf: (p) =>
      new Map<string, TupleUse>([
        ...(extra.own ?? []).map(
          (r) => [r.id, { role: "membership" }] as [string, TupleUse],
        ),
        ["ws:base", { role: "membership", match: { id: new Set([conv(p)]) } }],
        ["ws:attempt", { role: "membership" }],
      ]),
  });
}

const change = (
  table: string,
  op: TableChange["op"],
  ids: string[],
  unchanged: string[] | null = null,
): TableChange => ({
  source: "feed",
  table,
  op,
  ids,
  keys: { id: ids },
  unchanged,
});

/** A push value following conversations by `conv`, counting loads and hook calls. */
function follower(
  h: Harness,
  opts: {
    key?: string;
    mode?: "push" | "invalidate";
    hook?: (p: ResourceParams) => Promise<"repointed" | "unchanged">;
  } = {},
) {
  const loads: string[] = [];
  const reached: string[] = [];
  const key = opts.key ?? "follower";
  h.runtime.defineResource(
    {
      key,
      schema: z.object({ n: z.number() }),
      validateParams: () => {},
    },
    {
      mode: opts.mode ?? "push",
      loader: (p: ResourceParams) => {
        loads.push(p.conv!);
        return { n: loads.length };
      },
      reach: followReach(),
      onFollowReached:
        opts.hook ??
        ((p) => {
          reached.push(p.conv!);
          return Promise.resolve("unchanged");
        }),
    },
  );
  return { loads, reached, key };
}

async function debugOf(h: Harness, key: string) {
  const res = await h.runtime.handleResourceHttp(
    new Request("http://localhost/api/resources/_debug"),
    { key: "_debug" },
  );
  const body = (await res.json()) as {
    resources: {
      key: string;
      follows: { name: string; collection: string }[];
      followRepoints: number;
      routeDrifted: string[];
    }[];
  };
  return body.resources.find((r) => r.key === key)!;
}

describe("minting a follow route", () => {
  const route = (over: Partial<FullRoute> = {}): FullRoute => ({
    id: "f:base",
    table: "t",
    map: { kind: "full", reason: "r" },
    columns: ["id"],
    via: { name: "f", collection: "c" },
    ...over,
  });

  test("a follow owns its table: an own route, an unfed / relation / tagged read of it is refused", () => {
    expect(() =>
      mintReachPlan({
        routes: [route(), route({ id: "own", via: undefined })],
        usesOf: () => new Map(),
      }),
    ).toThrow(/read through the follow "f" and by the plan's own route "own"/);
    expect(() =>
      mintReachPlan({
        routes: [route()],
        usesOf: () => new Map(),
        taggedReads: [{ table: "t", tag: "lookup" }],
      }),
    ).toThrow(/read through the follow "f" and declared a tagged read/);
    expect(() =>
      mintReachPlan({
        routes: [route()],
        usesOf: () => new Map(),
        unfed: [{ table: "t", reason: "r" }],
      }),
    ).toThrow(/both routed and read outside the feed/);
  });

  test("one follow name reads one collection; a keyed route plan holds no follow route", () => {
    expect(() =>
      mintReachPlan({
        routes: [
          route(),
          route({ id: "f:x", table: "u", via: { name: "f", collection: "d" } }),
        ],
        usesOf: () => new Map(),
      }),
    ).toThrow(/reads both "c" and "d"/);
    expect(() =>
      mintRoutePlan({
        routes: [{ ...route(), map: { kind: "identity" } }],
        usesOf: () => new Map(),
      }),
    ).toThrow(/a follow is a reach plan's/);
  });

  test("two follows may read one table (each its own collection's tuple)", () => {
    expect(() =>
      mintReachPlan({
        routes: [
          route(),
          route({ id: "g:base", via: { name: "g", collection: "d" } }),
        ],
        usesOf: () => new Map(),
      }),
    ).not.toThrow();
  });
});

describe("A8 — a follower's own capture never covers a followed table", () => {
  function guarded(captured: string[], strictRoutes: boolean) {
    const reports: string[] = [];
    const h = createHarness({
      lastReadSet: () => captured,
      strictRoutes,
      reportError: (label) => reports.push(label),
    });
    const f = follower(h);
    return { h, reports, ...f };
  }

  test("a run whose own span read nothing is covered (the follow's reads are the collection's span's)", async () => {
    const { h } = guarded([], true);
    await h.subscribe("follower", { conv: "a" });
    expect(h.frames.map((f) => f.kind)).toEqual(["sub-ack"]);
  });

  test("a followed table read by hand is drift: thrown under strictRoutes", async () => {
    const { h } = guarded(["conversations"], true);
    await h.subscribe("follower", { conv: "a" });
    expect(h.frames.map((f) => f.kind)).toEqual(["sub-error"]);
  });

  test("each run is judged on its own capture, never on the key's last run closing around it", async () => {
    const h = createHarness({
      // The key's last run, per key: always another tuple's empty run (a
      // pure follower's) — which closed after the run under judgement.
      lastReadSet: () => [],
      strictRoutes: true,
      wrapLoad: (_key, info, fn, capture) =>
        fn().then((value) => {
          capture(
            new Set(info.variant?.includes('"a"') ? ["conversations"] : []),
            undefined,
          );
          return value;
        }),
    });
    follower(h);
    await h.subscribe("follower", { conv: "b" });
    expect(h.frames.map((f) => f.kind)).toEqual(["sub-ack"]);
    // `a`'s own run read the followed table by hand: drift, whatever the
    // key's last run says.
    await h.subscribe("follower", { conv: "a" });
    expect(h.frames.map((f) => f.kind)).toEqual(["sub-ack", "sub-error"]);
  });

  test("in a running server it is reported and fails open: the table then reaches every tuple FULL", async () => {
    const { h, loads, reports } = guarded(["conversations"], false);
    await h.subscribe("follower", { conv: "a" });
    await h.subscribe("follower", { conv: "b" });
    expect(reports).toContain("route drift for follower");
    expect((await debugOf(h, "follower")).routeDrifted).toEqual([
      "conversations",
    ]);
    loads.length = 0;
    // Gated out by the follow route — now every tuple re-reads.
    h.runtime.routeTableChange(
      change("conversations", "U", ["z"], ["attempt_id", "id"]),
    );
    await settle();
    expect(loads.sort()).toEqual(["a", "b"]);
  });

  test("a persisted tables_read (no span recorded) judges a followed table by its name: covered", () => {
    const h = createHarness();
    follower(h);
    expect(
      h.runtime.seedRouteDrift([
        { key: "follower", tablesRead: ["conversations", "attempts"] },
      ]),
    ).toEqual([]);
  });

  test("a view read whole over a followed table is refused once the bases are known", () => {
    const h = createHarness({
      relationBases: (r) => (r === "conversations_v" ? ["conversations"] : [r]),
    });
    h.runtime.defineResource(
      { key: "wide", schema: z.number(), validateParams: () => {} },
      {
        mode: "push",
        loader: () => 1,
        reach: mintReachPlan<ResourceParams>({
          routes: followReach().routes,
          usesOf: () => new Map(),
          relations: [{ relation: "conversations_v", reason: "r" }],
        }),
      },
    );
    expect(() => h.runtime.indexRelationReads()).toThrow(
      /reads the relation "conversations_v" whole, and its base "conversations" through the follow "ws"/,
    );
  });
});

describe("routing through a follow route", () => {
  test("a gated U reaches no tuple; the key row only its own tuple; the far side every tuple", async () => {
    const h = createHarness();
    const { loads } = follower(h);
    await h.subscribe("follower", { conv: "a" });
    await h.subscribe("follower", { conv: "b" });
    loads.length = 0;
    h.runtime.routeTableChange(
      change("conversations", "U", ["a"], ["attempt_id", "id"]),
    );
    await settle();
    expect(loads).toEqual([]);
    h.runtime.routeTableChange(change("conversations", "U", ["a"], []));
    await settle();
    expect(loads).toEqual(["a"]);
    loads.length = 0;
    h.runtime.routeTableChange(change("attempts", "U", ["att"], []));
    await settle();
    expect(loads.sort()).toEqual(["a", "b"]);
  });

  test("R1 — a paged value's page: only the question whose tuple matched re-reads (FULL)", async () => {
    const h = createHarness();
    const loads: string[] = [];
    h.runtime.defineExternalResource(
      {
        key: "pages",
        schema: z.array(z.object({ id: z.string() })),
        keyed: { keyOf: (r: unknown) => (r as { id: string }).id },
        validateParams: () => {},
      },
      {
        membership: {
          kind: "window",
          limitOf: () => 10,
          familyOf: (p) => p.q!,
        },
        // The question names its conversation; its pages share it.
        reach: followReach((p) => JSON.parse(p.q!).conv as string),
        loader: (p: ResourceParams) => {
          loads.push(`${JSON.parse(p.q!).conv}/${p.page}`);
          return [{ id: `${p.page}-${loads.length}` }];
        },
        freshness: { kind: "notified" },
      },
    );
    const q = (conv: string) => JSON.stringify({ conv });
    await h.subscribe("pages", { q: q("a"), page: "1" });
    await h.subscribe("pages", { q: q("a"), page: "2" });
    await h.subscribe("pages", { q: q("b"), page: "1" });
    loads.length = 0;
    h.runtime.routeTableChange(change("conversations", "I", ["a"]));
    await settle();
    expect(loads.sort()).toEqual(["a/1", "a/2"]);
    expect(h.pushesFor("pages").map((f) => f.kind)).toContain("delta");
  });
});

describe("R2 — onFollowReached", () => {
  test("fires for the tracked tuples a follow route lets through, never for an untracked one or a gated write", async () => {
    const h = createHarness();
    const { reached } = follower(h);
    await h.subscribe("follower", { conv: "a" });
    await h.subscribe("follower", { conv: "b" });
    h.runtime.routeTableChange(
      change("conversations", "U", ["a"], ["attempt_id", "id"]),
    );
    expect(reached).toEqual([]);
    h.runtime.routeTableChange(change("conversations", "U", ["a"], []));
    // Synchronously from the router: before any drain ran.
    expect(reached).toEqual(["a"]);
    h.runtime.routeTableChange(change("conversations", "I", ["z"]));
    expect(reached).toEqual(["a"]);
    h.runtime.routeTableChange(change("attempts", "U", ["att"], []));
    expect(reached.slice(1).sort()).toEqual(["a", "b"]);
    await h.unsub("follower", { conv: "a" });
    reached.length = 0;
    h.runtime.routeTableChange(change("conversations", "U", ["a"], []));
    expect(reached).toEqual([]);
  });

  test("fires in invalidate mode too (no load runs) and outside any flight, in a `bg` origin", async () => {
    const origins: string[] = [];
    let inFlight = 0;
    const h = createHarness({
      wrapOrigin: (kind, key, fn) => {
        origins.push(`${kind}:${key}`);
        return fn();
      },
      wrapLoad: async (_key, _info, fn) => {
        inFlight += 1;
        try {
          return await fn();
        } finally {
          inFlight -= 1;
        }
      },
    });
    const flights: number[] = [];
    follower(h, {
      mode: "invalidate",
      hook: () => {
        flights.push(inFlight);
        return Promise.resolve("unchanged");
      },
    });
    await h.subscribe("follower", { conv: "a" });
    origins.length = 0;
    h.runtime.routeTableChange(change("conversations", "U", ["a"], []));
    expect(flights).toEqual([0]);
    expect(origins).toContain("bg:follower");
    await settle();
    expect(h.pushesFor("follower").map((f) => f.kind)).toEqual(["invalidate"]);
  });

  test("_debug lists the follows and counts re-points; a rejected hook is reported", async () => {
    const reports: string[] = [];
    const h = createHarness({ reportError: (label) => reports.push(label) });
    let answer: () => Promise<"repointed" | "unchanged"> = () =>
      Promise.resolve("repointed");
    follower(h, { hook: () => answer() });
    await h.subscribe("follower", { conv: "a" });
    h.runtime.routeTableChange(change("conversations", "U", ["a"], []));
    await settle();
    const debug = await debugOf(h, "follower");
    expect(debug.follows).toEqual([{ name: "ws", collection: "conv-ws:rows" }]);
    expect(debug.followRepoints).toBe(1);
    answer = () => Promise.reject(new Error("watch open failed"));
    h.runtime.routeTableChange(change("conversations", "U", ["a"], []));
    await settle();
    expect(reports).toContain(
      'onFollowReached failed for follower {"conv":"a"}',
    );
    expect((await debugOf(h, "follower")).followRepoints).toBe(1);
  });

  test("refused without a follow route — it would never fire", () => {
    const h = createHarness();
    expect(() =>
      h.runtime.defineResource(
        { key: "nofollow", schema: z.number(), validateParams: () => {} },
        {
          mode: "push",
          loader: () => 1,
          reach: mintReachPlan({
            routes: [
              {
                id: "t",
                table: "t",
                map: { kind: "full", reason: "r" },
                columns: ["id"],
              },
            ],
            usesOf: () => new Map(),
          }),
          onFollowReached: () => Promise.resolve("unchanged"),
        },
      ),
    ).toThrow(/has no follow route/);
  });
});

describe("loadResourceFresh", () => {
  test("runs the entry's own loader in its own loader span, never joining an in-flight read", async () => {
    const spans: string[] = [];
    const h = createHarness({
      wrapLoad: (key, _info, fn) => {
        spans.push(key);
        return fn();
      },
    });
    const c = controllable({ n: 1 });
    c.block();
    let calls = 0;
    h.runtime.defineExternalResource(
      {
        key: "col",
        schema: z.object({ n: z.number() }),
        validateParams: () => {},
      },
      {
        mode: "push",
        loader: () => {
          calls += 1;
          return c.loader();
        },
        freshness: { kind: "notified" },
      },
    );
    // A read in flight (a sub-ack load, held).
    void h.subscribe("col", {});
    await tick();
    expect(calls).toBe(1);
    const fresh = h.runtime.loadResourceFresh("col", {});
    await tick();
    // Its own run, not the held flight.
    expect(calls).toBe(2);
    c.release();
    expect(await fresh).toEqual({ n: 1 });
    expect(spans.filter((k) => k === "col").length).toBe(2);
  });

  test("throws on an unknown key and a tuple its params gate refuses", async () => {
    const h = createHarness();
    h.runtime.defineExternalResource(
      {
        key: "gated",
        schema: z.number(),
        validateParams: (p) => {
          if (p.x === undefined) throw new Error("x required");
        },
      },
      { mode: "push", loader: () => 1, freshness: { kind: "notified" } },
    );
    expect(
      (await rejection(h.runtime.loadResourceFresh("nope", {}))).message,
    ).toMatch(/unknown resource key/);
    expect(
      (await rejection(h.runtime.loadResourceFresh("gated", {}))).message,
    ).toMatch(/x required/);
  });
});
