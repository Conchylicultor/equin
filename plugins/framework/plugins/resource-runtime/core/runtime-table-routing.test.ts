/**
 * Scoped change routing (`routeTableChange`, `./routing`) — the P0 runtime seam
 * of research/2026-09-29-global-scoped-change-routing.md, driven DB-free with
 * routes injected on the resource the way a compiler will emit them. Run with
 * `./singularity test plugins/framework/plugins/resource-runtime`.
 *
 * The fixture is one simulated database: `hosts` (the window's identity table),
 * `hosts_ext` (a 1:1 extension keyed by its host — an `alias` route), and
 * `sources` (an N:1 lookup the hosts reference — a `reverse` route). The window
 * orders hosts by `n`; `tag` / `enabled` params filter by the joined columns,
 * which is what turns their routes from the `value` role into `membership`; a
 * `maxN` param filters by the base's own `n` (a point tuple's `where`).
 *
 * The matrix (op × map kind × role × membership kind × several routes on one
 * table) pins, per cell: which tuples get a pending, scoped vs FULL vs ack-only,
 * `deleted` only from an identity D, the loader ids, the frames, the ack after
 * every route, the freshness floor, skipped tuples' versions, and fail-open on a
 * throwing `usesOf` / `encode` / `resolve`. The named scenarios of the plan's
 * Verification §2 follow.
 */

import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  mintReachPlan,
  mintRoutePlan,
  type Route,
  type TupleUse,
} from "./routing";
import {
  createHarness,
  makeClientView,
  tick,
  type RecordedFrame,
} from "./test-support";
import type { ResourceParams, ResourceRuntimeOptions } from "./runtime";

const rowSchema = z.object({
  id: z.string(),
  n: z.number(),
  tag: z.string().nullable(),
  label: z.string().nullable(),
});
const rowsSchema = z.array(rowSchema);
type Row = z.infer<typeof rowSchema>;
const keyOf = (r: unknown) => (r as Row).id;

// Two macrotasks: the flush, and a re-drain pass it may schedule.
const settle = async () => {
  await tick();
  await tick();
};

const sameParams = (a: ResourceParams | undefined, b: ResourceParams) =>
  a !== undefined &&
  JSON.stringify(Object.entries(a).sort()) ===
    JSON.stringify(Object.entries(b).sort());

// --- The simulated database -------------------------------------------------

function makeWorld() {
  const hosts = new Map<string, { n: number; src: string | null }>();
  const ext = new Map<string, string>(); // parent_id → tag
  const sources = new Map<string, { label: string; enabled: boolean }>();
  const rowOf = (id: string): Row => {
    const h = hosts.get(id)!;
    const s = h.src !== null ? sources.get(h.src) : undefined;
    return { id, n: h.n, tag: ext.get(id) ?? null, label: s?.label ?? null };
  };
  const matches = (p: ResourceParams, id: string): boolean => {
    const h = hosts.get(id);
    if (!h) return false;
    if (p.maxN !== undefined && h.n > Number(p.maxN)) return false;
    if (p.tag !== undefined && ext.get(id) !== p.tag) return false;
    if (p.enabled === "1" && !(h.src !== null && sources.get(h.src)?.enabled))
      return false;
    return true;
  };
  const members = (p: ResourceParams): Row[] =>
    [...hosts.keys()]
      .filter((id) => matches(p, id))
      .map(rowOf)
      .sort((a, b) => a.n - b.n || (a.id < b.id ? -1 : 1));
  return { hosts, ext, sources, rowOf, matches, members };
}
type World = ReturnType<typeof makeWorld>;

type ResolveCall = { changed: string[]; within: string[] | null };

// The compiler-shaped plan for the world: the base table is an identity route,
// the extension an alias through its `parent_id`, the lookup a reverse route
// whose `resolve` answers which hosts reference the changed sources.
function worldRoutes(w: World, log: ResolveCall[]): Route[] {
  return [
    {
      id: "hosts",
      table: "hosts",
      map: { kind: "identity" },
      columns: ["id", "n", "src"],
    },
    {
      id: "ext",
      table: "hosts_ext",
      map: { kind: "alias", column: "parent_id" },
      columns: ["parent_id", "tag"],
    },
    {
      id: "src",
      table: "sources",
      map: {
        kind: "reverse",
        column: "id",
        resolve: async (changed, within, cap) => {
          log.push({
            changed: [...changed].sort(),
            within: within ? [...within].sort() : null,
          });
          const out = [...w.hosts]
            .filter(
              ([id, h]) =>
                h.src !== null &&
                changed.includes(h.src) &&
                (within === null || within.has(id)),
            )
            .map(([id]) => id);
          return out.length > cap ? "over-cap" : out;
        },
      },
      columns: ["id", "label", "enabled"],
    },
  ];
}

// A tuple reads the extension (the lookup) as MEMBERSHIP when it filters by its
// column, and only as a projected VALUE otherwise.
const worldUses = (p: ResourceParams): ReadonlyMap<string, TupleUse> =>
  new Map<string, TupleUse>([
    ["hosts", { role: "membership" }],
    ["ext", { role: p.tag !== undefined ? "membership" : "value" }],
    ["src", { role: p.enabled === "1" ? "membership" : "value" }],
  ]);

interface FixtureOpts {
  runtime?: ResourceRuntimeOptions & { sockets?: number };
  routes?: (w: World, log: ResolveCall[]) => Route[];
  uses?: (p: ResourceParams) => ReadonlyMap<string, TupleUse>;
  kind?: "window" | "point" | "alias";
}

// A routed membership resource "win" over the world. `window` = the first
// `limit` members; `point` = the ids named by the `ids` param; `alias` = the
// unbounded `scopedMembership` window. Records every loader call, windowIdsOf
// run and resolve call; `park()` makes the NEXT loader call capture its rows and
// then wait — a SELECT that already ran — until released; `failLoads(n)` makes
// the next `n` loader calls throw (recorded all the same).
function routed(opts: FixtureOpts = {}) {
  const w = makeWorld();
  const loads: Array<{ params: ResourceParams; ids: string[] | "FULL" }> = [];
  const resolveLog: ResolveCall[] = [];
  const reports: string[] = [];
  let windowIdsCalls = 0;
  let parkNext: Promise<void> | null = null;
  let failing = 0;
  const h = createHarness({
    reportError: (ctx) => reports.push(ctx),
    ...opts.runtime,
  });
  const kind = opts.kind ?? "window";
  const limitOf = (p: ResourceParams) => Number(p.limit ?? "3");
  const pointIds = (p: ResourceParams) =>
    (p.ids ?? "").split(",").filter(Boolean);
  const full = (p: ResourceParams): Row[] =>
    kind === "point"
      ? pointIds(p)
          .filter((id) => w.matches(p, id))
          .map(w.rowOf)
      : kind === "alias"
        ? w.members(p)
        : w.members(p).slice(0, limitOf(p));
  const loader = async (
    p: ResourceParams,
    c?: { affectedIds: readonly string[] },
  ): Promise<Row[]> => {
    loads.push({ params: p, ids: c ? [...c.affectedIds].sort() : "FULL" });
    if (failing > 0) {
      failing--;
      throw new Error("injected loader failure");
    }
    const rows = c
      ? c.affectedIds.filter((id) => w.matches(p, id)).map(w.rowOf)
      : full(p);
    const park = parkNext;
    parkNext = null;
    if (park) await park;
    return rows;
  };
  const plan = mintRoutePlan({
    routes: (opts.routes ?? worldRoutes)(w, resolveLog),
    usesOf: opts.uses ?? worldUses,
  });
  const contract = {
    key: "win",
    schema: rowsSchema,
    keyed: { keyOf },
    validateParams: () => {},
  };
  if (kind === "point") {
    h.runtime.defineResource(contract, {
      routes: plan,
      membership: { kind: "point", idsOf: pointIds },
      loader,
    });
  } else if (kind === "alias") {
    h.runtime.defineResource(contract, {
      routes: plan,
      scopedMembership: {
        orderOf: async (p) => {
          windowIdsCalls++;
          return w.members(p).map((r) => r.id);
        },
        // The world's ORDER BY is (n, id); the routed alias states it.
        orderSignatureOf: (r) => String((r as Row).n),
      },
      loader,
    });
  } else {
    h.runtime.defineResource(contract, {
      routes: plan,
      membership: {
        kind: "window",
        windowIdsOf: async (p) => {
          windowIdsCalls++;
          return w
            .members(p)
            .slice(0, limitOf(p))
            .map((r) => r.id);
        },
        orderSignatureOf: (r) => String((r as Row).n),
        limitOf,
      },
      loader,
    });
  }
  const change = (
    table: string,
    op: "I" | "U" | "D",
    o: {
      ids?: string[] | null;
      keys?: Record<string, (string | null)[]> | null;
      unchanged?: string[] | null;
      xid?: string;
    } = {},
  ) =>
    h.runtime.routeTableChange({
      source: "feed",
      table,
      op,
      ids: o.ids ?? null,
      keys: o.keys ?? null,
      unchanged: o.unchanged ?? null,
      ...(o.xid !== undefined ? { xid: o.xid } : {}),
    });
  const framesOf = (params: ResourceParams, socket = 0): RecordedFrame[] =>
    h.frames.filter(
      (f) =>
        f.key === "win" && f.socket === socket && sameParams(f.params, params),
    );
  return {
    h,
    w,
    loads,
    resolveLog,
    reports,
    change,
    full,
    get windowIdsCalls() {
      return windowIdsCalls;
    },
    park(): () => void {
      let release!: () => void;
      parkNext = new Promise<void>((r) => {
        release = r;
      });
      return release;
    },
    failLoads(n: number): void {
      failing = n;
    },
    framesOf,
    pushesOf: (params: ResourceParams) =>
      framesOf(params).filter((f) => f.kind !== "sub-ack"),
    /** The client simulator's converged value for a tuple (socket 0). */
    clientValue(params: ResourceParams): unknown {
      const v = makeClientView(keyOf);
      v.applyAll(framesOf(params));
      return v.value;
    },
    loadsSince(n: number) {
      return loads.slice(n);
    },
  };
}
type Fixture = ReturnType<typeof routed>;

// h1..h4 at n = 1..4; h1, h2 on source s1 (enabled), h3 on s2 (disabled).
function seed(f: Fixture): void {
  f.w.sources.set("s1", { label: "S1", enabled: true });
  f.w.sources.set("s2", { label: "S2", enabled: false });
  f.w.hosts.set("h1", { n: 1, src: "s1" });
  f.w.hosts.set("h2", { n: 2, src: "s1" });
  f.w.hosts.set("h3", { n: 3, src: "s2" });
  f.w.hosts.set("h4", { n: 4, src: null });
}

const W3 = { limit: "3" };

async function seeded(opts: FixtureOpts = {}, params: ResourceParams = W3) {
  const f = routed(opts);
  seed(f);
  await f.h.subscribe("win", params);
  return f;
}

const deltas = (frames: RecordedFrame[]) =>
  frames.filter((f) => f.kind === "delta");

// --- Identity routes ----------------------------------------------------------

describe("identity routes", () => {
  test("a U refills exactly its ids, scoped, and the client converges", async () => {
    const f = await seeded();
    const at = f.loads.length;
    f.w.hosts.get("h2")!.n = 2.5;
    f.change("hosts", "U", { ids: ["h2"] });
    await settle();
    expect(f.loadsSince(at)[0]).toEqual({ params: W3, ids: ["h2"] });
    expect(f.loadsSince(at).every((l) => l.ids !== "FULL")).toBe(true);
    expect(f.clientValue(W3)).toEqual(f.full(W3));
  });

  test("an I admits an entrant through windowIdsOf; a D exits with NO loader run for the deleted id", async () => {
    const f = await seeded();
    let at = f.loads.length;
    f.w.hosts.set("h0", { n: 0, src: null });
    f.change("hosts", "I", { ids: ["h0"] });
    await settle();
    expect(f.loadsSince(at)).toEqual([{ params: W3, ids: ["h0"] }]);
    expect(f.clientValue(W3)).toEqual(f.full(W3)); // h3 squeezed out

    at = f.loads.length;
    f.w.hosts.delete("h1");
    f.change("hosts", "D", { ids: ["h1"] });
    await settle();
    // No refill of h1 — a deleted row cannot be read; only the backfilled tail.
    expect(f.loadsSince(at)).toEqual([{ params: W3, ids: ["h3"] }]);
    expect(f.clientValue(W3)).toEqual(f.full(W3));
  });

  test("unknown rows (ids null) recompute the tuple FULL — the bounded window load", async () => {
    const f = await seeded();
    const at = f.loads.length;
    f.change("hosts", "U", { ids: null });
    await settle();
    expect(f.loadsSince(at)).toEqual([{ params: W3, ids: "FULL" }]);
  });

  test("a known-empty change (ids: []) touches nothing", async () => {
    const f = await seeded();
    const at = f.loads.length;
    f.change("hosts", "U", { ids: [] });
    await settle();
    expect(f.loadsSince(at)).toEqual([]);
    expect(f.pushesOf(W3)).toEqual([]);
  });

  test("an identity route with encode maps a table id into the host's key space", async () => {
    const f = routed({
      kind: "point",
      routes: () => [
        {
          id: "arm",
          table: "hosts",
          map: { kind: "identity", encode: (v) => `a:${v}` },
          columns: ["n"],
        },
      ],
      uses: () => new Map([["arm", { role: "membership" }]]),
    });
    f.w.hosts.set("a:h1", { n: 1, src: null });
    const P = { ids: "a:h1" };
    await f.h.subscribe("win", P);
    const at = f.loads.length;
    f.change("hosts", "U", { ids: ["h2"] }); // encodes to a:h2 — not in the set
    await settle();
    expect(f.loadsSince(at)).toEqual([]);
    f.change("hosts", "U", { ids: ["h1"] });
    await settle();
    expect(f.loadsSince(at)).toEqual([{ params: P, ids: ["a:h1"] }]);
  });
});

// --- Alias routes (a side table carrying its host key) ------------------------

describe("alias routes", () => {
  test("value role: a write to a MEMBER's extension refills that member only — no windowIdsOf", async () => {
    const f = await seeded();
    const at = f.loads.length;
    const ids = f.windowIdsCalls;
    f.w.ext.set("h2", "x");
    f.change("hosts_ext", "U", { ids: ["h2"], keys: { parent_id: ["h2"] } });
    await settle();
    expect(f.loadsSince(at)).toEqual([{ params: W3, ids: ["h2"] }]);
    expect(f.windowIdsCalls).toBe(ids);
    expect(f.clientValue(W3)).toEqual(f.full(W3));
  });

  test("value role: a write to a NON-member's extension on a quiescent tuple loads nothing; its writer gets an ack iff asked, and no version moves", async () => {
    const f = routed();
    seed(f);
    await f.h.subscribe("win", W3, { acks: true });
    const base = f.framesOf(W3).find((x) => x.kind === "sub-ack")!.version!;
    const at = f.loads.length;
    const feed = f.h.runtime.notifyStatsFor("win").feed;
    f.w.ext.set("h4", "x");
    f.change("hosts_ext", "I", {
      ids: ["h4"],
      keys: { parent_id: ["h4"] },
      xid: "700",
    });
    await settle();
    expect(f.loadsSince(at)).toEqual([]);
    expect(f.pushesOf(W3).map((x) => [x.kind, x.ackTx])).toEqual([
      ["ack", ["700"]],
    ]);
    // The owed ack is still a feed delivery to the tuple (hand-vs-feed counters).
    expect(f.h.runtime.notifyStatsFor("win").feed).toBe(feed + 1);
    // The next real change ships at the sub-ack's version + 1.
    f.w.hosts.get("h1")!.n = 1.5;
    f.change("hosts", "U", { ids: ["h1"] });
    await settle();
    expect(deltas(f.pushesOf(W3)).at(-1)!.version).toBe(base + 1);
  });

  test("point twin: a value-role write to a requested NON-member's extension loads nothing; its writer still gets its ack, and no version moves", async () => {
    // h4 is requested but outside `maxN` — not a member of the point snapshot.
    const P = { ids: "h1,h4", maxN: "3" };
    const f = routed({ kind: "point" });
    seed(f);
    await f.h.subscribe("win", P, { acks: true });
    const base = f.framesOf(P).find((x) => x.kind === "sub-ack")!.version!;
    const at = f.loads.length;
    f.w.ext.set("h4", "x");
    f.change("hosts_ext", "I", {
      ids: ["h4"],
      keys: { parent_id: ["h4"] },
      xid: "701",
    });
    await settle();
    expect(f.loadsSince(at)).toEqual([]);
    expect(f.pushesOf(P).map((x) => [x.kind, x.ackTx])).toEqual([
      ["ack", ["701"]],
    ]);
    f.w.hosts.get("h1")!.n = 1.5;
    f.change("hosts", "U", { ids: ["h1"] });
    await settle();
    expect(deltas(f.pushesOf(P)).at(-1)!.version).toBe(base + 1);
  });

  test("a side-table I / U / D is a host U: an extension DELETE refills its host, never deletes it", async () => {
    const f = await seeded();
    f.w.ext.set("h2", "x");
    f.change("hosts_ext", "I", { ids: ["h2"], keys: { parent_id: ["h2"] } });
    await settle();
    const at = f.loads.length;
    f.w.ext.delete("h2");
    f.change("hosts_ext", "D", { ids: ["h2"], keys: { parent_id: ["h2"] } });
    await settle();
    expect(f.loadsSince(at)).toEqual([{ params: W3, ids: ["h2"] }]);
    const last = deltas(f.pushesOf(W3)).at(-1)!;
    expect(last.deletes ?? []).toEqual([]);
    expect(f.clientValue(W3)).toEqual(f.full(W3));
  });

  test("membership role: a joined-filter flip refills the host and admits it through windowIdsOf", async () => {
    const T = { limit: "3", tag: "x" };
    const f = await seeded({}, T);
    expect(f.clientValue(T)).toEqual([]);
    const ids = f.windowIdsCalls;
    f.w.ext.set("h3", "x");
    f.change("hosts_ext", "I", { ids: ["h3"], keys: { parent_id: ["h3"] } });
    await settle();
    expect(f.windowIdsCalls).toBe(ids + 1);
    expect(f.clientValue(T)).toEqual(f.full(T));
    expect((f.clientValue(T) as Row[]).map((r) => r.id)).toEqual(["h3"]);
  });

  test("unknown keys: a map reading a non-PK column recomputes FULL", async () => {
    const f = await seeded();
    const at = f.loads.length;
    f.change("hosts_ext", "U", { ids: ["h2"], keys: null });
    await settle();
    expect(f.loadsSince(at)).toEqual([{ params: W3, ids: "FULL" }]);
  });
});

// --- Reverse routes (the host side references the changed row) ----------------

describe("reverse routes", () => {
  test("value role: resolved in the drain, bounded to the tuple's members", async () => {
    const f = await seeded();
    const at = f.loads.length;
    f.w.sources.get("s1")!.label = "S1'";
    f.change("sources", "U", { ids: ["s1"], keys: { id: ["s1"] } });
    await settle();
    expect(f.resolveLog).toEqual([
      { changed: ["s1"], within: ["h1", "h2", "h3"] },
    ]);
    expect(f.loadsSince(at)).toEqual([{ params: W3, ids: ["h1", "h2"] }]);
    expect(f.clientValue(W3)).toEqual(f.full(W3));
  });

  // The resolve self-queries the DB to translate changed lookup values into
  // host ids: an ids-translation read, not part of the value (nor its
  // read-set), so it runs under the `cascade` origin — the loader DB gate and
  // the profiler's `cascade:<key>` — while the refill it feeds is the `push`.
  test("the resolve runs under the `cascade` origin; the refill under `push`", async () => {
    const origins: Array<[string, string]> = [];
    const f = await seeded({
      runtime: {
        wrapOrigin: (kind, key, fn) => {
          origins.push([kind, key]);
          return fn();
        },
      },
    });
    origins.length = 0;
    f.change("sources", "U", { ids: ["s1"], keys: { id: ["s1"] } });
    await settle();
    expect(f.resolveLog).toHaveLength(1);
    expect(origins).toEqual([
      ["cascade", "win"],
      ["push", "win"],
    ]);
  });

  test("membership role: resolved unbounded (within null)", async () => {
    const E = { limit: "3", enabled: "1" };
    const f = await seeded({}, E);
    f.change("sources", "U", { ids: ["s2"], keys: { id: ["s2"] } });
    await settle();
    expect(f.resolveLog).toEqual([{ changed: ["s2"], within: null }]);
  });

  test("one flush resolves ONCE per route: over every reading tuple, within the union of their members", async () => {
    const L2 = { limit: "2" };
    const f = await seeded();
    await f.h.subscribe("win", L2);
    const at = f.loads.length;
    f.change("sources", "U", { ids: ["s1"], keys: { id: ["s1"] } });
    await settle();
    expect(f.resolveLog).toEqual([
      { changed: ["s1"], within: ["h1", "h2", "h3"] },
    ]);
    expect(f.loadsSince(at).map((l) => [l.params.limit, l.ids])).toEqual([
      ["3", ["h1", "h2"]],
      ["2", ["h1", "h2"]],
    ]);
  });

  test("a second change for a tuple that already has a pending unions into ONE resolve — unbounded, since the tuple is no longer quiescent", async () => {
    const f = await seeded();
    f.change("sources", "U", { ids: ["s1"], keys: { id: ["s1"] } });
    f.change("sources", "U", { ids: ["s2"], keys: { id: ["s2"] } });
    await settle();
    expect(f.resolveLog).toEqual([{ changed: ["s1", "s2"], within: null }]);
  });

  test("a membership reader beside a value reader: ONE unbounded resolve, cut to each value reader's members", async () => {
    const E = { limit: "3", enabled: "1" };
    const f = await seeded();
    await f.h.subscribe("win", E);
    const at = f.loads.length;
    f.w.sources.get("s1")!.label = "S1'";
    f.change("sources", "U", { ids: ["s1"], keys: { id: ["s1"] } });
    await settle();
    expect(f.resolveLog).toEqual([{ changed: ["s1"], within: null }]);
    expect(
      f
        .loadsSince(at)
        .map((l) => [l.params.enabled ?? "-", l.ids])
        .sort(),
    ).toEqual([
      ["-", ["h1", "h2"]],
      ["1", ["h1", "h2"]],
    ]);
    expect(f.clientValue(W3)).toEqual(f.full(W3));
    expect(f.clientValue(E)).toEqual(f.full(E));
  });

  test("over the cap, only the membership reader recomputes FULL: the value reader resolves again within its own members", async () => {
    const E = { limit: "3", enabled: "1" };
    const f = routed();
    seed(f);
    // 501 hosts reference s9, none of them in W3's window.
    f.w.sources.set("s9", { label: "S9", enabled: false });
    for (let i = 0; i < 501; i++) {
      f.w.hosts.set(`z${String(i).padStart(3, "0")}`, {
        n: 100 + i,
        src: "s9",
      });
    }
    await f.h.subscribe("win", W3, { acks: true });
    await f.h.subscribe("win", E);
    const base = f.framesOf(W3).find((x) => x.kind === "sub-ack")!.version!;
    const at = f.loads.length;
    f.w.sources.get("s9")!.enabled = true;
    f.change("sources", "U", {
      ids: ["s9"],
      keys: { id: ["s9"] },
      xid: "800",
    });
    await settle();
    expect(f.resolveLog).toEqual([
      { changed: ["s9"], within: null },
      { changed: ["s9"], within: ["h1", "h2", "h3"] },
    ]);
    // W3 holds none of s9's hosts: its resolve names no row, so its pending is
    // an empty scoped one — the drain's skip: nothing loaded, no value frame,
    // no version bump, only the ack it asked for.
    expect(f.loadsSince(at)).toEqual([{ params: E, ids: "FULL" }]);
    expect(f.pushesOf(W3).map((x) => [x.kind, x.ackTx])).toEqual([
      ["ack", ["800"]],
    ]);
    expect(f.clientValue(W3)).toEqual(f.full(W3));
    expect(f.clientValue(E)).toEqual(f.full(E));
    // The next real change ships at the sub-ack's version + 1.
    f.w.hosts.get("h1")!.n = 1.5;
    f.change("hosts", "U", { ids: ["h1"] });
    await settle();
    expect(deltas(f.pushesOf(W3)).at(-1)!.version).toBe(base + 1);
  });

  // The same skip on a PERSISTED alias: it runs before the persisted branch,
  // which would otherwise force a FULL reload (and a replace persist) for a
  // change that touched none of the tuple's rows.
  test("a persisted alias whose reverse resolves to no host neither loads nor persists — only its ack", async () => {
    let persists = 0;
    const f = routed({
      kind: "alias",
      runtime: {
        shouldPersist: () => true,
        captureWatermark: async () => "1",
        persistSnapshot: async () => {
          persists++;
        },
      },
    });
    seed(f);
    f.w.sources.set("s9", { label: "S9", enabled: true }); // no host references it
    await f.h.subscribe("win", {}, { acks: true });
    await settle();
    const at = f.loads.length;
    const persisted = persists;
    f.w.sources.get("s9")!.label = "S9'";
    f.change("sources", "U", {
      ids: ["s9"],
      keys: { id: ["s9"] },
      xid: "801",
    });
    await settle();
    expect(f.resolveLog.at(-1)).toEqual({
      changed: ["s9"],
      within: ["h1", "h2", "h3", "h4"],
    });
    expect(f.loadsSince(at)).toEqual([]);
    expect(persists).toBe(persisted);
    expect(f.pushesOf({}).map((x) => [x.kind, x.ackTx])).toEqual([
      ["ack", ["801"]],
    ]);
    // Positive control: a source a member references does reach the tuple.
    f.w.sources.get("s1")!.label = "S1'";
    f.change("sources", "U", { ids: ["s1"], keys: { id: ["s1"] } });
    await settle();
    expect(f.loadsSince(at).length).toBeGreaterThan(0);
    expect(f.clientValue({})).toEqual(f.full({}));
  });

  // The compiler omits `column` on a lookup by the changed table's own PK:
  // the changed values are then `change.ids`, and no key is carried.
  const pkReverseRoutes = (w: World, log: ResolveCall[]): Route[] =>
    worldRoutes(w, log).map((r) => {
      if (r.map.kind !== "reverse") return r;
      const { column: _column, ...map } = r.map;
      return { ...r, map };
    });

  test("a column-less reverse (on the PK) resolves `change.ids` — no keys needed", async () => {
    const f = await seeded({ routes: pkReverseRoutes });
    expect(
      f.h.runtime.routedTableRequirements().find((r) => r.table === "sources")!
        .carry,
    ).toEqual([]);
    const at = f.loads.length;
    f.w.sources.get("s1")!.label = "S1'";
    f.change("sources", "U", { ids: ["s1"], keys: null });
    await settle();
    expect(f.resolveLog).toEqual([
      { changed: ["s1"], within: ["h1", "h2", "h3"] },
    ]);
    expect(f.loadsSince(at)).toEqual([{ params: W3, ids: ["h1", "h2"] }]);
    expect(f.clientValue(W3)).toEqual(f.full(W3));
  });

  test("a column-less reverse: unknown ids (null) recompute FULL; a known-empty set ([]) touches nothing", async () => {
    const f = await seeded({ routes: pkReverseRoutes });
    let at = f.loads.length;
    f.change("sources", "U", { ids: null, keys: null });
    await settle();
    expect(f.resolveLog).toEqual([]);
    expect(f.loadsSince(at)).toEqual([{ params: W3, ids: "FULL" }]);
    at = f.loads.length;
    const pushes = f.pushesOf(W3).length;
    f.change("sources", "U", { ids: [], keys: null });
    await settle();
    expect(f.resolveLog).toEqual([]);
    expect(f.loadsSince(at)).toEqual([]);
    expect(f.pushesOf(W3).length).toBe(pushes);
  });

  test("a throwing resolve recomputes its readers FULL, and is reported", async () => {
    const f = routed({
      routes: (w, log) =>
        worldRoutes(w, log).map((r) =>
          r.id === "src"
            ? {
                ...r,
                map: {
                  kind: "reverse" as const,
                  column: "id",
                  resolve: async () => {
                    throw new Error("resolve failed");
                  },
                },
              }
            : r,
        ),
    });
    seed(f);
    await f.h.subscribe("win", W3);
    const at = f.loads.length;
    f.change("sources", "U", { ids: ["s1"], keys: { id: ["s1"] } });
    await settle();
    expect(f.loadsSince(at)).toEqual([{ params: W3, ids: "FULL" }]);
    expect(f.reports.some((r) => r.includes('reverse route "src"'))).toBe(true);
  });
});

// --- Full routes, the gate, key filters, several routes on one table ----------

describe("full routes, gate, key filter, several routes per table", () => {
  const blobRoutes = (w: World, log: ResolveCall[]): Route[] => [
    ...worldRoutes(w, log),
    {
      id: "blob",
      table: "blobs",
      map: { kind: "full", reason: "a closure nothing can map" },
      columns: ["id"],
    },
  ];
  const blobUses = (p: ResourceParams) => {
    const uses = new Map(worldUses(p));
    if (p.blob === "1") uses.set("blob", { role: "membership" });
    return uses;
  };

  test("a full route recomputes exactly the tuples that read it; the others keep their version", async () => {
    const A = { limit: "3", blob: "1" };
    const f = routed({ routes: blobRoutes, uses: blobUses });
    seed(f);
    await f.h.subscribe("win", A);
    await f.h.subscribe("win", W3);
    const at = f.loads.length;
    f.change("blobs", "U", { ids: ["b1"] });
    await settle();
    expect(f.loadsSince(at)).toEqual([{ params: A, ids: "FULL" }]);
    expect(f.pushesOf(W3)).toEqual([]);
  });

  test("the gate: a U leaving every referenced column `unchanged` routes nowhere; one column moved, or unknown, routes", async () => {
    const f = await seeded();
    let at = f.loads.length;
    // Only `updated_at` moved: both columns the route reads are listed.
    f.change("hosts_ext", "U", {
      ids: ["h1"],
      keys: { parent_id: ["h1"] },
      unchanged: ["parent_id", "tag"],
    });
    await settle();
    expect(f.loadsSince(at)).toEqual([]);
    at = f.loads.length;
    f.change("hosts_ext", "U", {
      ids: ["h1"],
      keys: { parent_id: ["h1"] },
      unchanged: ["parent_id"],
    });
    f.change("hosts_ext", "U", {
      ids: ["h2"],
      keys: { parent_id: ["h2"] },
      unchanged: null,
    });
    await settle();
    expect(f.loadsSince(at)).toEqual([{ params: W3, ids: ["h1", "h2"] }]);
  });

  test("the gate: a column the producer did not compare is not listed, so a route reading it is reached — whatever else is listed", async () => {
    // The trigger compares only the columns of routes narrower than the
    // table; a whole-table reader's other columns are never listed, and the
    // `unchanged` set is sound for it without any agreement on the gate.
    const f = await seeded();
    const at = f.loads.length;
    f.change("hosts_ext", "U", {
      ids: ["h1"],
      keys: { parent_id: ["h1"] },
      unchanged: ["parent_id", "other"],
    });
    await settle();
    expect(f.loadsSince(at)).toEqual([{ params: W3, ids: ["h1"] }]);
  });

  test("two routes on one table (a self-join) union their host ids; a full one absorbs them", async () => {
    const selfJoin = (w: World, log: ResolveCall[]): Route[] => [
      ...worldRoutes(w, log),
      {
        id: "hosts-parent",
        table: "hosts",
        map: { kind: "alias", column: "parent" },
        columns: ["parent"],
      },
    ];
    const uses = (p: ResourceParams) =>
      new Map(worldUses(p)).set("hosts-parent", { role: "membership" });
    const f = await seeded({ routes: selfJoin, uses });
    const at = f.loads.length;
    f.change("hosts", "U", {
      ids: ["h4"],
      keys: { id: ["h4"], parent: ["h1"] },
    });
    await settle();
    expect(f.loadsSince(at)[0]).toEqual({ params: W3, ids: ["h1", "h4"] });

    const withFull = (w: World, log: ResolveCall[]): Route[] => [
      ...worldRoutes(w, log),
      {
        id: "hosts-closure",
        table: "hosts",
        map: { kind: "full", reason: "closure" },
        columns: ["id"],
      },
    ];
    const g = await seeded({
      routes: withFull,
      uses: (p) =>
        new Map(worldUses(p)).set("hosts-closure", { role: "membership" }),
    });
    const at2 = g.loads.length;
    g.change("hosts", "U", { ids: ["h1"] });
    await settle();
    expect(g.loadsSince(at2)).toEqual([{ params: W3, ids: "FULL" }]);
  });
});

// --- `moves`: a U that cannot move the tuple is a value change for it ----------

// Each case runs for a window and for a point tuple. The point set names a
// member (h1), requested non-members (h3, h4: outside `maxN`) and an absent
// row (h0), so a non-member's neutral U is dropped there too, and a move on `n`
// (its `where`) admits it.
const POINT = { ids: "h0,h1,h3,h4", maxN: "2" };
interface MovesCase {
  kind: "window" | "point";
  base: ResourceParams;
  race: ResourceParams;
  filtered: ResourceParams;
  filteredMembers: string[];
  entrantWithin: string[] | null;
  /** The loads an identity D of member h1 costs (after h0 entered). */
  exitLoads: string[][];
}
describe.each<MovesCase>([
  {
    kind: "window",
    base: W3,
    race: { limit: "2" },
    filtered: { limit: "3", enabled: "1" },
    filteredMembers: ["h1", "h2"],
    entrantWithin: null,
    // The window [h0, h1, h2] loses h1 and backfills its new tail, h3.
    exitLoads: [["h3"]],
  },
  {
    kind: "point",
    base: POINT,
    race: POINT,
    // `maxN: 3` lets h3 in once its source is enabled (the reverse entrant).
    filtered: { ...POINT, maxN: "3", enabled: "1" },
    filteredMembers: ["h1"],
    // A membership-role reverse is bounded by what could enter: the id set.
    entrantWithin: ["h0", "h1", "h3", "h4"],
    // A point set has no tail: the exit loads nothing.
    exitLoads: [],
  },
])(
  "moves — a membership use's membership-neutral U ($kind)",
  ({
    kind,
    base,
    race,
    filtered,
    filteredMembers,
    entrantWithin,
    exitLoads,
  }) => {
    // The base moves on `n` (the order, and the point `where`) only, the
    // lookup on `enabled` (a filtered tuple's predicate) and `id` (its join key).
    const movingUses = (p: ResourceParams): ReadonlyMap<string, TupleUse> =>
      new Map<string, TupleUse>([
        ["hosts", { role: "membership", moves: ["n"] }],
        ["ext", { role: p.tag !== undefined ? "membership" : "value" }],
        [
          "src",
          p.enabled === "1"
            ? { role: "membership", moves: ["enabled", "id"] }
            : { role: "value" },
        ],
      ]);
    const ids = (f: Fixture, params: ResourceParams) =>
      (f.clientValue(params) as Row[]).map((r) => r.id);
    // The client converged to the loader's truth. A point set is unordered
    // (an entrant appends), so it is compared by id; a window in order.
    const expectConverged = (f: Fixture, params: ResourceParams) => {
      const byId = (rows: Row[]) =>
        kind === "point"
          ? [...rows].sort((a, b) => (a.id < b.id ? -1 : 1))
          : rows;
      expect(byId(f.clientValue(params) as Row[])).toEqual(
        byId(f.full(params)),
      );
    };

    test("an identity U missing every moving column refills only a member, with no windowIdsOf; a non-member loads nothing", async () => {
      const f = await seeded({ kind, uses: movingUses }, base);
      const at = f.loads.length;
      const calls = f.windowIdsCalls;
      f.w.hosts.get("h1")!.src = "s2";
      f.change("hosts", "U", { ids: ["h1"], unchanged: ["id", "n"] });
      await settle();
      // Quiescent again (a pending would deliver it as membership — the guard).
      f.change("hosts", "U", { ids: ["h4"], unchanged: ["id", "n"] });
      await settle();
      expect(f.loadsSince(at)).toEqual([{ params: base, ids: ["h1"] }]);
      expect(f.windowIdsCalls).toBe(calls);
      expectConverged(f, base);
    });

    test("an identity U touching a moving column stays membership: a non-member is a candidate entrant", async () => {
      const f = await seeded({ kind, uses: movingUses }, base);
      const at = f.loads.length;
      f.w.hosts.get("h4")!.n = 0;
      f.change("hosts", "U", { ids: ["h4"], unchanged: ["id", "src"] });
      await settle();
      expect(f.loadsSince(at)).toEqual([{ params: base, ids: ["h4"] }]);
      expectConverged(f, base);
      expect(ids(f, base)).toContain("h4"); // the positive control: it entered
    });

    test("a membership-neutral U to a non-member is still delivered while the tuple has a pending (the quiescence guard)", async () => {
      const f = await seeded({ kind, uses: movingUses }, base);
      const at = f.loads.length;
      f.w.hosts.get("h4")!.n = 0; // a real move: h4 is a candidate entrant…
      f.change("hosts", "U", { ids: ["h4"], unchanged: ["id", "src"] });
      // …and, in the same flush, a neutral U to h3 (its source).
      f.w.hosts.get("h3")!.src = "s1";
      f.change("hosts", "U", { ids: ["h3"], unchanged: ["id", "n"] });
      await settle();
      expect(f.loadsSince(at)[0]).toEqual({ params: base, ids: ["h3", "h4"] });
      expectConverged(f, base);
    });

    test("a membership-neutral U to the host a drain is admitting ends fresh (the quiescence race, via `moves`)", async () => {
      const f = await seeded({ kind, uses: movingUses }, race);
      const release = f.park();
      f.w.hosts.get("h3")!.n = 0; // h3 enters the tuple…
      f.change("hosts", "U", { ids: ["h3"], unchanged: ["id", "src"] });
      await tick(); // …its refill read source s2 and parked
      // A neutral U (only `src` moved) commits mid-drain: h3 is no member of
      // the snapshot yet, but it must not be dropped as a value change.
      f.w.hosts.get("h3")!.src = "s1";
      f.change("hosts", "U", { ids: ["h3"], unchanged: ["id", "n"] });
      release();
      await settle();
      await settle();
      expectConverged(f, race);
      expect(
        (f.clientValue(race) as Row[]).find((r) => r.id === "h3"),
      ).toMatchObject({ label: "S1" });
    });

    test("unknown `unchanged`, an I and a D stay membership whatever `moves` says", async () => {
      const f = await seeded({ kind, uses: movingUses }, base);
      const at = f.loads.length;
      f.w.hosts.set("h0", { n: 0, src: "s1" });
      f.change("hosts", "I", { ids: ["h0"] });
      f.change("hosts", "U", { ids: ["h4"], unchanged: null });
      await settle();
      expect(f.loadsSince(at)).toEqual([{ params: base, ids: ["h0", "h4"] }]);
      expectConverged(f, base);
      const at2 = f.loads.length;
      f.w.hosts.delete("h1");
      f.change("hosts", "D", { ids: ["h1"] });
      await settle();
      // An identity D exits h1 with no refill of it (a window backfills its tail).
      expect(f.loadsSince(at2)).toEqual(
        exitLoads.map((ids) => ({ params: base, ids })),
      );
      expect(ids(f, base)).not.toContain("h1");
      expectConverged(f, base);
    });

    test("a reverse route's U missing its moving columns resolves within the members; one touching them resolves unbounded", async () => {
      const f = await seeded({ kind, uses: movingUses }, filtered);
      f.w.sources.get("s1")!.label = "S1'";
      f.change("sources", "U", {
        ids: ["s1"],
        keys: { id: ["s1"] },
        unchanged: ["enabled", "id"],
      });
      await settle();
      expect(f.resolveLog).toEqual([
        { changed: ["s1"], within: filteredMembers },
      ]);
      f.resolveLog.length = 0;
      const at = f.loads.length;
      f.w.sources.get("s2")!.enabled = true;
      f.change("sources", "U", {
        ids: ["s2"],
        keys: { id: ["s2"] },
        unchanged: ["id", "label"],
      });
      await settle();
      expect(f.resolveLog).toEqual([
        { changed: ["s2"], within: entrantWithin },
      ]);
      // The positive control: s2's enable admits h3, its only referrer.
      expect(f.loadsSince(at)).toEqual([{ params: filtered, ids: ["h3"] }]);
      expect(ids(f, filtered)).toContain("h3");
      expectConverged(f, filtered);
    });

    // A failed drain consumes its pending: a snapshot it left as it was could
    // miss the member the change admitted, and the router would drop that
    // member's every later value-only change. The failure evicts it instead.
    test("a membership drain whose loads all fail leaves no stale diff base: the next value-only U to its entrant re-seeds the tuple", async () => {
      const f = await seeded({ kind, uses: movingUses }, base);
      const at = f.loads.length;
      f.failLoads(2); // the scoped refill, then its FULL fallback
      f.w.hosts.get("h4")!.n = 0; // h4 enters…
      f.change("hosts", "U", { ids: ["h4"], unchanged: ["id", "src"] });
      await settle();
      expect(ids(f, base)).not.toContain("h4"); // …but no frame said so
      f.w.hosts.get("h4")!.src = "s1"; // a neutral U to the missed entrant
      f.change("hosts", "U", { ids: ["h4"], unchanged: ["id", "n"] });
      await settle();
      expect(f.loadsSince(at)).toEqual([
        { params: base, ids: ["h4"] },
        { params: base, ids: "FULL" },
        { params: base, ids: "FULL" }, // no diff base: the FULL re-seed
      ]);
      expect(ids(f, base)).toContain("h4");
      expectConverged(f, base);
    });
  },
);

// --- Targets: which tuples a change can reach --------------------------------

describe("targets", () => {
  test("a param'd routed entry with NO subscriber gets no {} tuple — nothing loads", async () => {
    const f = routed();
    seed(f);
    f.change("hosts", "U", { ids: ["h1"] });
    f.change("hosts", "U", { ids: null });
    await settle();
    expect(f.loads).toEqual([]);
  });

  test("an unsubscribed tuple leaves the targets", async () => {
    const f = await seeded();
    await f.h.unsub("win", W3);
    const at = f.loads.length;
    f.change("hosts", "U", { ids: ["h1"] });
    await settle();
    expect(f.loadsSince(at)).toEqual([]);
  });

  test("a persisted routed alias keeps its {} value current with nobody subscribed", async () => {
    const persisted: string[] = [];
    const f = routed({
      kind: "alias",
      runtime: {
        shouldPersist: () => true,
        captureWatermark: async () => "1",
        persistSnapshot: async (key) => {
          persisted.push(key);
        },
      },
    });
    seed(f);
    f.change("hosts", "U", { ids: ["h1"] });
    await settle();
    expect(f.loads).toEqual([{ params: {}, ids: "FULL" }]);
    expect(persisted).toEqual(["win"]);
  });

  test("a persisted routed alias floor-persists with its route tables as the A6 guard tables (C21) and its plan's definition", async () => {
    const persists: Array<{
      mode: string;
      guard: readonly string[];
      definition: string | null;
      wm: string;
    }> = [];
    const f = routed({
      kind: "alias",
      runtime: {
        shouldPersist: () => true,
        persistWindowMs: 0,
        captureWatermark: async () => "7",
        persistSnapshot: async (_key, _pk, _value, wm, meta) => {
          persists.push({
            mode: meta.mode,
            guard: meta.guardTables,
            definition: meta.definition,
            wm,
          });
        },
      },
    });
    seed(f);
    f.change("hosts", "U", { ids: ["h1"] });
    await settle(); // no snapshot yet: FULL → replace
    f.w.hosts.get("h1")!.n = 0.5;
    f.change("hosts", "U", { ids: ["h1"] });
    await settle();
    await settle(); // the trailing window
    expect(persists.map((p) => p.mode)).toEqual(["replace", "floor"]);
    // Never an empty list: a floor persist's first INSERT is guarded too.
    expect(persists[1]!.guard).toEqual(["hosts", "hosts_ext", "sources"]);
    expect(persists[1]!.wm).toBe("7"); // the replace's flight floor = the base
    expect(f.h.runtime.persistedDefinitions()).toEqual({});
  });

  test("point membership: every route's ids are intersected with the tuple's set; a value-role write loads only a member; a value-role reverse resolves within the members", async () => {
    // h1 and h3 requested; h3 (n = 3) is outside `maxN`, so h1 is the only member.
    const P = { ids: "h1,h3", maxN: "2" };
    const f = routed({ kind: "point" });
    seed(f);
    await f.h.subscribe("win", P);
    let at = f.loads.length;
    f.change("hosts_ext", "U", { ids: ["h2"], keys: { parent_id: ["h2"] } });
    await settle();
    expect(f.loadsSince(at)).toEqual([]);
    // A requested non-member: the value-only write cannot admit it — nothing loads.
    f.change("hosts_ext", "U", { ids: ["h3"], keys: { parent_id: ["h3"] } });
    await settle();
    expect(f.loadsSince(at)).toEqual([]);
    f.w.ext.set("h1", "x");
    f.change("hosts_ext", "U", { ids: ["h1"], keys: { parent_id: ["h1"] } });
    await settle();
    expect(f.loadsSince(at)).toEqual([{ params: P, ids: ["h1"] }]);
    at = f.loads.length;
    f.change("sources", "U", { ids: ["s1"], keys: { id: ["s1"] } });
    await settle();
    expect(f.resolveLog).toEqual([{ changed: ["s1"], within: ["h1"] }]);
    expect(f.loadsSince(at)).toEqual([{ params: P, ids: ["h1"] }]);
    expect(f.clientValue(P)).toEqual(f.full(P));
  });
});

// --- Acks ---------------------------------------------------------------------

describe("acks", () => {
  test("reverse + identity on the same xid: ONE frame, carrying the ack only after every route landed", async () => {
    const f = routed();
    seed(f);
    await f.h.subscribe("win", W3, { acks: true });
    f.w.hosts.get("h1")!.n = 1.5;
    f.w.sources.get("s1")!.label = "S1'";
    f.change("hosts", "U", { ids: ["h1"], xid: "900" });
    f.change("sources", "U", { ids: ["s1"], keys: { id: ["s1"] }, xid: "900" });
    await settle();
    const pushes = f.pushesOf(W3);
    expect(pushes.map((x) => [x.kind, x.ackTx])).toEqual([["delta", ["900"]]]);
    expect(f.clientValue(W3)).toEqual(f.full(W3));
  });

  test("an ack owed to a skipped tuple folds into that tuple's real pending of the same flush", async () => {
    const f = routed();
    seed(f);
    await f.h.subscribe("win", W3, { acks: true });
    f.w.hosts.get("h1")!.n = 1.5;
    f.change("hosts_ext", "U", {
      ids: ["h4"],
      keys: { parent_id: ["h4"] },
      xid: "901",
    }); // skipped: h4 is no member
    f.change("hosts", "U", { ids: ["h1"], xid: "902" });
    await settle();
    expect(f.pushesOf(W3).map((x) => [x.kind, x.ackTx?.sort()])).toEqual([
      ["delta", ["901", "902"]],
    ]);
  });

  test("a persisted skip NEVER loads: a routed persisted alias's untouched tuple gets only its ack", async () => {
    const f = routed({
      kind: "alias",
      runtime: {
        shouldPersist: () => true,
        captureWatermark: async () => "1",
        persistSnapshot: async () => {},
      },
    });
    seed(f);
    await f.h.subscribe("win", {}, { acks: true });
    const at = f.loads.length;
    // An orphan extension row (its parent is no host): no member is touched.
    f.change("hosts_ext", "I", {
      ids: ["nobody"],
      keys: { parent_id: ["nobody"] },
      xid: "903",
    });
    await settle();
    expect(f.loadsSince(at)).toEqual([]);
    expect(f.pushesOf({}).map((x) => [x.kind, x.ackTx])).toEqual([
      ["ack", ["903"]],
    ]);
  });
});

// --- Fail open ------------------------------------------------------------------

describe("fail open", () => {
  test("a throwing usesOf recomputes the tuple FULL, reported once (memoized per tuple)", async () => {
    const f = await seeded({
      uses: () => {
        throw new Error("usesOf failed");
      },
    });
    const at = f.loads.length;
    f.change("hosts", "U", { ids: ["h1"] });
    await settle();
    f.change("hosts", "U", { ids: ["h2"] });
    await settle();
    expect(f.loadsSince(at)).toEqual([
      { params: W3, ids: "FULL" },
      { params: W3, ids: "FULL" },
    ]);
    expect(f.reports.filter((r) => r.startsWith("usesOf failed"))).toHaveLength(
      1,
    );
  });

  test("a usesOf naming an unknown route id recomputes FULL, reported (A9)", async () => {
    const f = await seeded({
      uses: (p) =>
        new Map(worldUses(p)).set("no-such-route", { role: "value" }),
    });
    const at = f.loads.length;
    f.change("hosts", "U", { ids: ["h1"] });
    await settle();
    expect(f.loadsSince(at)).toEqual([{ params: W3, ids: "FULL" }]);
    expect(
      f.reports.some((r) => r.startsWith("usesOf named an unknown route")),
    ).toBe(true);
  });

  test("a throwing encode recomputes the tuple FULL, reported", async () => {
    const f = routed({
      kind: "point",
      routes: () => [
        {
          id: "arm",
          table: "hosts",
          map: {
            kind: "identity",
            encode: () => {
              throw new Error("encode failed");
            },
          },
          columns: ["n"],
        },
      ],
      uses: () => new Map([["arm", { role: "membership" }]]),
    });
    seed(f);
    const P = { ids: "h1" };
    await f.h.subscribe("win", P);
    const at = f.loads.length;
    f.change("hosts", "U", { ids: ["h1"] });
    await settle();
    expect(f.loadsSince(at)).toEqual([{ params: P, ids: "FULL" }]);
    expect(f.reports.some((r) => r.startsWith("routing failed"))).toBe(true);
  });
});

// --- Freshness -------------------------------------------------------------------

describe("freshness", () => {
  test("a routed FULL refreshes the floor: its drain refuses a read flight that started before the change", async () => {
    const f = await seeded();
    const release = f.park();
    const read = f.h.runtime.handleResourceHttp(
      new Request("http://x/api/resources/win?limit=3"),
      { key: "win" },
    );
    await tick(); // the HTTP flight has read (and parked)
    f.w.ext.set("h1", "fresh");
    f.change("hosts_ext", "U", { ids: ["h1"], keys: null }); // unknown keys ⇒ FULL
    await settle();
    // The drain ran its own load instead of joining the pre-change flight.
    expect(f.loads.filter((l) => l.ids === "FULL")).toHaveLength(3);
    expect((f.clientValue(W3) as Row[])[0]!.tag).toBe("fresh");
    release();
    await read;
  });

  // The quiescence guard (plan §3.6): a drain admitting h3 may read h3's
  // extension BEFORE a concurrent write to it commits. Dropping that write as a
  // value-role non-member change would leave h3 stale for good.
  test("a side write committing during an admitting drain ends fresh (the quiescence race)", async () => {
    const f = await seeded({}, { limit: "2" });
    const L2 = { limit: "2" };
    const release = f.park();
    f.w.ext.set("h3", "old");
    f.w.hosts.get("h3")!.n = 0; // h3 enters the window…
    f.change("hosts", "U", { ids: ["h3"] });
    await tick(); // …its refill read `old` and parked
    f.w.ext.set("h3", "new"); // the side write commits mid-drain
    f.change("hosts_ext", "U", { ids: ["h3"], keys: { parent_id: ["h3"] } });
    release();
    await settle();
    await settle();
    expect(f.clientValue(L2)).toEqual(f.full(L2));
    expect((f.clientValue(L2) as Row[])[0]).toMatchObject({
      id: "h3",
      tag: "new",
    });
  });

  // A sub-ack whose load started before a push must not regress the snapshot the
  // push advanced: the value-role drop reads membership off that snapshot, and a
  // quiescent tuple whose (regressed) snapshot lacks h3 would drop h3's later
  // side write for good — on every tab that already holds h3.
  test("a second tab's sub-ack loaded before a drain admitted h3 does not un-admit it from the diff base", async () => {
    const L2 = { limit: "2" };
    const f = routed({ runtime: { sockets: 2 } });
    seed(f);
    await f.h.subscribe("win", L2); // tab A: [h1, h2]
    const release = f.park();
    await f.h.subscribe("win", L2, { socket: 1 }); // tab B's load read [h1, h2] and parked
    f.w.hosts.get("h3")!.n = 0; // M: h3 enters the window
    f.change("hosts", "U", { ids: ["h3"] });
    await settle(); // the drain admitted h3: the diff base is [h3, h1]
    release();
    await settle(); // tab B's sub-ack lands
    const at = f.loads.length;
    f.w.ext.set("h3", "new"); // W: a value-role write to h3's extension
    f.change("hosts_ext", "U", { ids: ["h3"], keys: { parent_id: ["h3"] } });
    await settle();
    expect(f.loadsSince(at)).toEqual([{ params: L2, ids: ["h3"] }]);
    expect(f.clientValue(L2)).toEqual(f.full(L2));
    expect((f.clientValue(L2) as Row[])[0]).toMatchObject({
      id: "h3",
      tag: "new",
    });
  });

  // The point twin, through a value-role REVERSE route. The write lands while a
  // drain admits h3, so it is lifted to membership; it resolves in the NEXT
  // drain (a mid-drain change is a new pending), whose snapshot already holds
  // h3 — so its bound names h3 by either path, and h3 ends fresh.
  test("a lookup write committing while a drain admits h3 into a point set ends fresh (the quiescence race, reverse route)", async () => {
    const P = { ids: "h1,h3", maxN: "2" };
    const f = routed({ kind: "point" });
    seed(f);
    await f.h.subscribe("win", P); // [h1]
    const release = f.park();
    f.w.hosts.get("h3")!.n = 0; // h3 enters the set…
    f.change("hosts", "U", { ids: ["h3"] });
    await tick(); // …its refill read label `S2` and parked
    f.w.sources.get("s2")!.label = "S2'"; // the lookup write commits mid-drain
    f.change("sources", "U", { ids: ["s2"], keys: { id: ["s2"] } });
    release();
    await settle();
    await settle();
    expect(f.resolveLog).toEqual([{ changed: ["s2"], within: ["h1", "h3"] }]);
    expect(
      [...(f.clientValue(P) as Row[])].sort((a, b) => (a.id < b.id ? -1 : 1)),
    ).toEqual(f.full(P));
    expect(
      (f.clientValue(P) as Row[]).find((r) => r.id === "h3"),
    ).toMatchObject({ label: "S2'" });
  });

  // The point twin of the sub-ack regression: a point tuple drops a value-only
  // change to an id its snapshot lacks, so a regressed base would drop h3's.
  test("a second tab's sub-ack loaded before a drain admitted h3 into a point set does not un-admit it from the diff base", async () => {
    const P = { ids: "h1,h3", maxN: "2" };
    const f = routed({ kind: "point", runtime: { sockets: 2 } });
    seed(f);
    await f.h.subscribe("win", P); // tab A: [h1]
    const release = f.park();
    await f.h.subscribe("win", P, { socket: 1 }); // tab B's load read [h1] and parked
    f.w.hosts.get("h3")!.n = 0; // M: h3 enters the set
    f.change("hosts", "U", { ids: ["h3"] });
    await settle(); // the drain admitted h3: the diff base is {h1, h3}
    release();
    await settle(); // tab B's sub-ack lands
    const at = f.loads.length;
    f.w.ext.set("h3", "new"); // W: a value-role write to h3's extension
    f.change("hosts_ext", "U", { ids: ["h3"], keys: { parent_id: ["h3"] } });
    await settle();
    expect(f.loadsSince(at)).toEqual([{ params: P, ids: ["h3"] }]);
    expect(
      (f.clientValue(P) as Row[]).find((r) => r.id === "h3"),
    ).toMatchObject({ tag: "new" });
  });
});

// --- Named scenarios (plan, Verification §2) ---------------------------------

describe("named scenarios", () => {
  test("a cascaded extension D plus its host D, in the SAME flush: one exit, no phantom row", async () => {
    const f = await seeded();
    f.w.ext.set("h2", "x");
    f.change("hosts_ext", "I", { ids: ["h2"], keys: { parent_id: ["h2"] } });
    await settle();
    f.w.ext.delete("h2");
    f.w.hosts.delete("h2");
    f.change("hosts_ext", "D", { ids: ["h2"], keys: { parent_id: ["h2"] } });
    f.change("hosts", "D", { ids: ["h2"] });
    await settle();
    expect(f.clientValue(W3)).toEqual(f.full(W3));
    expect((f.clientValue(W3) as Row[]).map((r) => r.id)).toEqual([
      "h1",
      "h3",
      "h4",
    ]);
  });

  test("a cascaded extension D plus its host D, in SPLIT flushes: the same outcome", async () => {
    const f = await seeded();
    f.w.ext.set("h2", "x");
    f.w.ext.delete("h2");
    f.w.hosts.delete("h2");
    f.change("hosts_ext", "D", { ids: ["h2"], keys: { parent_id: ["h2"] } });
    await settle();
    expect(f.clientValue(W3)).toEqual(f.full(W3));
    f.change("hosts", "D", { ids: ["h2"] });
    await settle();
    expect(f.clientValue(W3)).toEqual(f.full(W3));
    expect(f.h.frames.filter((x) => x.kind === "sub-error")).toEqual([]);
  });

  test("a key-changing UPDATE: old ∪ new ids exit the old key and admit the new", async () => {
    const f = await seeded();
    const h1 = f.w.hosts.get("h1")!;
    f.w.hosts.delete("h1");
    f.w.hosts.set("h9", h1); // UPDATE hosts SET id = 'h9' WHERE id = 'h1'
    f.change("hosts", "U", { ids: ["h1", "h9"] });
    await settle();
    expect((f.clientValue(W3) as Row[]).map((r) => r.id)).toEqual([
      "h9",
      "h2",
      "h3",
    ]);
    // And a side row moving hosts names both of them (keys over old ∪ new).
    const at = f.loads.length;
    f.w.ext.set("h2", "moved");
    f.change("hosts_ext", "U", {
      ids: ["e1"],
      keys: { parent_id: ["h4", "h2"] },
    });
    await settle();
    // h4 is no member of a quiescent tuple: only h2 refills.
    expect(f.loadsSince(at)).toEqual([{ params: W3, ids: ["h2"] }]);
    expect(f.clientValue(W3)).toEqual(f.full(W3));
  });

  test("an `enabled` flip under the cap refills just the referencing hosts; over the cap it recomputes the bounded window", async () => {
    const E = { limit: "3", enabled: "1" };
    const f = await seeded({}, E);
    expect((f.clientValue(E) as Row[]).map((r) => r.id)).toEqual(["h1", "h2"]);
    let at = f.loads.length;
    f.w.sources.get("s2")!.enabled = true;
    f.change("sources", "U", {
      ids: ["s2"],
      keys: { id: ["s2"] },
      unchanged: ["id", "label"],
    });
    await settle();
    expect(f.loadsSince(at)[0]).toEqual({ params: E, ids: ["h3"] });
    expect(f.clientValue(E)).toEqual(f.full(E));

    // Over the cap: 501 hosts reference s9.
    f.w.sources.set("s9", { label: "S9", enabled: false });
    for (let i = 0; i < 501; i++) {
      f.w.hosts.set(`z${String(i).padStart(3, "0")}`, {
        n: 100 + i,
        src: "s9",
      });
    }
    at = f.loads.length;
    f.w.sources.get("s9")!.enabled = true;
    f.change("sources", "U", { ids: ["s9"], keys: { id: ["s9"] } });
    await settle();
    expect(f.loadsSince(at)).toEqual([{ params: E, ids: "FULL" }]);
    expect(f.clientValue(E)).toEqual(f.full(E));
  });

  test("a write to custom column c2 while a tuple sorts by c1 loads nothing (keyed-side key filter)", async () => {
    // A composite-keyed side table: (data_view_id, row_key, column_id). The route
    // keeps only its surface's rows; the tuple matches only the column it reads.
    const custom = (w: World, log: ResolveCall[]): Route[] => [
      ...worldRoutes(w, log),
      {
        id: "cc",
        table: "custom_values",
        map: { kind: "alias", column: "row_key" },
        columns: ["data_view_id", "row_key", "column_id", "value"],
        rows: { data_view_id: "surface-a" },
        match: ["column_id"],
      },
    ];
    const uses = (p: ResourceParams) => {
      const m = new Map(worldUses(p));
      if (p.sort !== undefined) {
        m.set("cc", {
          role: "membership",
          match: { column_id: new Set([p.sort]) },
        });
      }
      return m;
    };
    const S = { limit: "3", sort: "c1" };
    const f = await seeded({ routes: custom, uses }, S);
    const at = f.loads.length;
    const cv = (surface: string, column: string) => ({
      ids: null,
      keys: {
        data_view_id: [surface],
        row_key: ["h1"],
        column_id: [column],
      },
    });
    f.change("custom_values", "U", cv("surface-a", "c2"));
    f.change("custom_values", "U", cv("surface-b", "c1"));
    await settle();
    expect(f.loadsSince(at)).toEqual([]);
    f.change("custom_values", "U", cv("surface-a", "c1"));
    await settle();
    expect(f.loadsSince(at)[0]).toEqual({ params: S, ids: ["h1"] });
  });

  test("a match on a column the route does not declare is refused: reported, and the tuple recomputes FULL", async () => {
    const custom = (w: World, log: ResolveCall[]): Route[] => [
      ...worldRoutes(w, log),
      {
        id: "cc",
        table: "custom_values",
        map: { kind: "alias", column: "row_key" },
        columns: ["data_view_id", "row_key", "column_id", "value"],
        rows: { data_view_id: "surface-a" },
        // No `match`: the feed would not carry `column_id` for it.
      },
    ];
    const uses = (p: ResourceParams) => {
      const m = new Map(worldUses(p));
      m.set("cc", {
        role: "membership",
        match: { column_id: new Set(["c1"]) },
      });
      return m;
    };
    const S = { limit: "3", sort: "c1" };
    const f = await seeded({ routes: custom, uses }, S);
    const at = f.loads.length;
    f.change("custom_values", "U", {
      ids: null,
      keys: {
        data_view_id: ["surface-a"],
        row_key: ["h1"],
        column_id: ["c2"],
      },
    });
    await settle();
    expect(f.loadsSince(at)).toEqual([{ params: S, ids: "FULL" }]);
    expect(f.reports).toContain(
      "usesOf matched on an undeclared column for win",
    );
  });

  test("a key-changing identity UPDATE (old ∪ new ids) exits the old id and admits the new", async () => {
    const f = await seeded();
    // `UPDATE hosts SET id = 'h1b'`: the routed trigger sends both ids.
    const h1 = f.w.hosts.get("h1")!;
    f.w.hosts.delete("h1");
    f.w.hosts.set("h1b", h1);
    const at = f.loads.length;
    f.change("hosts", "U", { ids: ["h1", "h1b"] });
    await settle();
    expect(f.loadsSince(at)[0]).toEqual({ params: W3, ids: ["h1", "h1b"] });
    expect(f.clientValue(W3)).toEqual(f.full(W3));
    expect((f.clientValue(W3) as Row[]).map((r) => r.id)).toEqual([
      "h1b",
      "h2",
      "h3",
    ]);
  });
});

// --- Registration -----------------------------------------------------------

describe("registration", () => {
  const plan = mintRoutePlan({ routes: [], usesOf: () => new Map() });

  // A `routes` entry is a membership entry, so D32 refuses it as a cascade
  // upstream (the old A5 was its redundant twin, and is gone).
  test("D32: a dependsOn edge whose upstream is a `routes` entry throws", () => {
    const f = routed();
    expect(() =>
      f.h.runtime.defineResource({
        key: "downstream",
        mode: "push",
        schema: z.number(),
        dependsOn: [{ resource: { key: "win" } as never }],
        loader: () => 1,
      }),
    ).toThrow(
      /cascades from the keyed window "win" — a membership drain cascades nothing \(D32\)/,
    );
  });

  test("D32 in the other registration order: a `routes` entry registered after a downstream naming it throws", () => {
    const h = createHarness();
    h.runtime.defineResource({
      key: "downstream",
      mode: "push",
      schema: z.number(),
      dependsOn: [{ resource: { key: "win" } as never }],
      loader: () => 1,
    });
    expect(() =>
      h.runtime.defineResource(
        {
          key: "win",
          schema: rowsSchema,
          keyed: { keyOf },
          validateParams: () => {},
        },
        {
          routes: mintRoutePlan({
            routes: [
              { id: "b", table: "t", map: { kind: "identity" }, columns: [] },
            ],
            usesOf: () => new Map(),
          }),
          membership: { kind: "point", idsOf: () => [] },
          loader: () => [],
        },
      ),
    ).toThrow(
      /"downstream" cascades from the keyed window "win" — a membership drain cascades nothing \(D32\)/,
    );
  });

  // A reach EXTERNAL upstream may cascade (`edited-files` →
  // `review.plugin-changes`): its cascade carries its own changes, and the
  // downstream declares its own reads. A table change to the upstream's reads
  // reaches the downstream through the cascade.
  function reachUpstreamCascade(order: "upstream-first" | "downstream-first") {
    const h = createHarness();
    const downLoads: ResourceParams[] = [];
    const defineUp = () =>
      h.runtime.defineExternalResource(
        { key: "edits", schema: z.number(), validateParams: () => {} },
        {
          mode: "push",
          reach: mintReachPlan({
            routes: [
              {
                id: "c",
                table: "conversations",
                map: { kind: "full", reason: "resolves the worktree" },
                columns: ["id"],
              },
            ],
            usesOf: () => new Map([["c", { role: "membership" as const }]]),
          }),
          loader: () => 1,
        },
      );
    const defineDown = () =>
      h.runtime.defineExternalResource(
        { key: "changes", schema: z.number(), validateParams: () => {} },
        {
          mode: "push",
          dependsOn: [
            { resource: { key: "edits" } as never, toSubscribed: true },
          ],
          loader: (p) => {
            downLoads.push(p);
            return downLoads.length;
          },
        },
      );
    if (order === "upstream-first") {
      defineUp();
      defineDown();
    } else {
      defineDown();
      defineUp();
    }
    return { h, downLoads };
  }

  test("a reach external upstream may cascade: a change to its reads reaches the downstream", async () => {
    const { h, downLoads } = reachUpstreamCascade("upstream-first");
    await h.subscribe("edits", {});
    await h.subscribe("changes", { id: "a" });
    downLoads.length = 0;
    h.runtime.routeTableChange({
      source: "feed",
      table: "conversations",
      op: "U",
      ids: ["x"],
      keys: null,
      unchanged: null,
    });
    await settle();
    expect(downLoads).toEqual([{ id: "a" }]);
  });

  test("a reach external upstream registered after a downstream naming it is accepted", () => {
    expect(() => reachUpstreamCascade("downstream-first")).not.toThrow();
  });

  test("routes need a membership, refuse a legacy scope key, and have unique ids", () => {
    const h = createHarness();
    const contract = (key: string) => ({
      key,
      schema: rowsSchema,
      keyed: { keyOf },
      validateParams: () => {},
    });
    expect(() =>
      h.runtime.defineResource(contract("a"), {
        routes: plan,
        loader: () => [],
      } as never),
    ).toThrow(/"routes" requires a membership/);
    // The deleted legacy arm, cast through (D37): refused by name.
    expect(() =>
      h.runtime.defineResource(contract("b"), {
        routes: plan,
        identityTable: "t",
        membership: { kind: "point", idsOf: () => [] },
        loader: () => [],
      } as never),
    ).toThrow(/"identityTable" on key "b" — the legacy scope policy is gone/);
    const dup: Route = {
      id: "r",
      table: "t",
      map: { kind: "identity" },
      columns: [],
    };
    expect(() =>
      h.runtime.defineResource(contract("c"), {
        routes: mintRoutePlan({ routes: [dup, dup], usesOf: () => new Map() }),
        membership: { kind: "point", idsOf: () => [] },
        loader: () => [],
      }),
    ).toThrow(/duplicate route id "r"/);
    // An external resource's truth is outside Postgres: no keyed route plan
    // routes into it.
    expect(() =>
      // An external resource is never keyed-ROUTED (D31) — the cast stands in
      // for the type, which has no `routes` on the external window arm.
      h.runtime.defineExternalResource(contract("d"), {
        routes: plan,
        membership: { kind: "point", idsOf: () => [] },
        loader: () => [],
      } as never),
    ).toThrow(/an external resource's truth lives outside Postgres/);
  });

  test("a plan is minted, never written: an unminted plan an `as` cast let through throws", () => {
    const h = createHarness();
    expect(() =>
      h.runtime.defineResource(
        {
          key: "hand",
          schema: rowsSchema,
          keyed: { keyOf },
          validateParams: () => {},
        },
        {
          routes: {
            routes: [
              { id: "b", table: "t", map: { kind: "identity" }, columns: [] },
            ],
            usesOf: () => new Map(),
          } as never,
          membership: { kind: "point", idsOf: () => [] },
          loader: () => [],
        },
      ),
    ).toThrow(/was not minted/);
    expect(() =>
      h.runtime.defineResource(
        { key: "hand-groups", schema: z.number(), validateParams: () => {} },
        {
          mode: "push",
          reach: {
            routes: [
              {
                id: "b",
                table: "t",
                map: { kind: "full", reason: "x" },
                columns: [],
              },
            ],
            usesOf: () => new Map(),
          } as never,
          loader: () => 1,
        },
      ),
    ).toThrow(/was not minted/);
  });

  test("a keyed routed entry takes no cascade: routes beside dependsOn throws", () => {
    const h = createHarness();
    // External, so the only thing refused is the cascade into a routed entry.
    const upstream = h.runtime.defineExternalResource({
      key: "up",
      mode: "push",
      schema: z.number(),
      loader: () => 1,
    });
    expect(() =>
      h.runtime.defineResource(
        {
          key: "routed-down",
          schema: rowsSchema,
          keyed: { keyOf },
          validateParams: () => {},
        },
        {
          routes: plan,
          membership: { kind: "point", idsOf: () => [] },
          dependsOn: [{ resource: upstream }],
          loader: () => [],
        } as never,
      ),
    ).toThrow(/"routes" and "dependsOn" are exclusive/);
  });
});

// --- The non-keyed `reach` arm (a collection's `:groups`) ---------------------

describe("reach — a non-keyed entry routed by full routes", () => {
  // A grouping over `hosts`: a push value per tuple. The `other` route is read
  // only by tuples with `joined: "1"` — the per-tuple read-set of a reach plan.
  function grouping(runtime: ResourceRuntimeOptions = {}) {
    const loads: ResourceParams[] = [];
    let value = 0;
    const reports: string[] = [];
    const h = createHarness({
      reportError: (ctx) => reports.push(ctx),
      ...runtime,
    });
    h.runtime.defineResource(
      { key: "groups", schema: z.number(), validateParams: () => {} },
      {
        mode: "push",
        reach: mintReachPlan({
          routes: [
            {
              id: "base",
              table: "hosts",
              map: { kind: "full", reason: "a count" },
              columns: ["id", "n"],
            },
            {
              id: "other",
              table: "other",
              map: { kind: "full", reason: "a joined count" },
              columns: ["id"],
            },
          ],
          usesOf: (p) =>
            new Map<string, TupleUse>(
              p.joined === "1"
                ? [
                    ["base", { role: "membership" }],
                    ["other", { role: "membership" }],
                  ]
                : [["base", { role: "membership" }]],
            ),
        }),
        loader: (p) => {
          loads.push(p);
          return ++value;
        },
      },
    );
    const change = (table: string, xid?: string) =>
      h.runtime.routeTableChange({
        source: "feed",
        table,
        op: "U",
        ids: ["x"],
        keys: null,
        unchanged: null,
        ...(xid !== undefined ? { xid } : {}),
      });
    return { h, loads, reports, change };
  }
  const PLAIN = { groupBy: "kind" };
  const JOINED = { groupBy: "kind", joined: "1" };

  test("a change to a table a tuple reads recomputes it FULL; a tuple that does not read it is untouched", async () => {
    const g = grouping();
    await g.h.subscribe("groups", PLAIN);
    await g.h.subscribe("groups", JOINED);
    g.loads.length = 0;
    g.change("hosts");
    await settle();
    expect(g.loads.map((p) => p.joined ?? "-").sort()).toEqual(["-", "1"]);
    g.loads.length = 0;
    g.change("other");
    await settle();
    expect(g.loads).toEqual([JOINED]);
  });

  test("a tuple the change skips owes only its ack — no load", async () => {
    const g = grouping();
    await g.h.subscribe("groups", PLAIN, { acks: true });
    g.loads.length = 0;
    g.change("other", "tx-9");
    await settle();
    expect(g.loads).toEqual([]);
    expect(
      g.h.frames.filter((f) => f.kind === "ack").map((f) => f.ackTx),
    ).toEqual([["tx-9"]]);
  });

  test("reach may sit beside dependsOn: an upstream notify and a routed change in one flush load the tuple once", async () => {
    const loads: ResourceParams[] = [];
    const h = createHarness();
    const upstream = h.runtime.defineExternalResource({
      key: "head",
      mode: "push",
      schema: z.number(),
      loader: () => 1,
    });
    h.runtime.defineResource(
      { key: "work", schema: z.number(), validateParams: () => {} },
      {
        mode: "push",
        reach: mintReachPlan({
          routes: [
            {
              id: "hosts",
              table: "hosts",
              map: { kind: "full", reason: "whole table" },
              columns: ["id"],
            },
          ],
          usesOf: () => new Map([["hosts", { role: "membership" as const }]]),
        }),
        dependsOn: [{ resource: upstream, toSubscribed: true }],
        loader: (p) => {
          loads.push(p);
          return loads.length;
        },
      },
    );
    await h.subscribe("work", { id: "a" });
    loads.length = 0;
    upstream.notify({});
    await settle();
    expect(loads).toEqual([{ id: "a" }]);
    loads.length = 0;
    upstream.notify({});
    h.runtime.routeTableChange({
      source: "feed",
      table: "hosts",
      op: "U",
      ids: ["x"],
      keys: null,
      unchanged: null,
    });
    await settle();
    expect(loads).toEqual([{ id: "a" }]);
  });

  test("reach is the non-keyed, full-only, table-routed arm: every other spelling throws", () => {
    const h = createHarness();
    const full = {
      id: "r",
      table: "t",
      map: { kind: "full" as const, reason: "x" },
      columns: [],
    };
    const reach = mintReachPlan({ routes: [full], usesOf: () => new Map() });
    expect(() =>
      h.runtime.defineResource(
        {
          key: "k1",
          schema: rowsSchema,
          keyed: { keyOf },
          validateParams: () => {},
        },
        { reach, loader: () => [] } as never,
      ),
    ).toThrow(/"reach" is the non-keyed arm/);
    expect(() =>
      h.runtime.defineResource(
        { key: "k2", schema: z.number(), validateParams: () => {} },
        {
          mode: "push",
          // Minted past the type (a cast), so the runtime's own check is reached.
          reach: mintReachPlan({
            routes: [{ ...full, map: { kind: "identity" } }] as never,
            usesOf: () => new Map(),
          }),
          loader: () => 1,
        } as never,
      ),
    ).toThrow(/every reach route is "full"/);
    expect(() =>
      h.runtime.defineResource(
        { key: "k3", schema: z.number(), validateParams: () => {} },
        {
          mode: "push",
          reach,
          identityTable: "t",
          loader: () => 1,
        } as never,
      ),
    ).toThrow(/"identityTable" on key "k3" — the legacy scope policy is gone/);
    // A non-keyed EXTERNAL entry may declare reach (D1) — the type allows it.
    expect(() =>
      h.runtime.defineExternalResource(
        { key: "k4", schema: z.number(), validateParams: () => {} },
        { mode: "push", reach, loader: () => 1 },
      ),
    ).not.toThrow();
    expect(h.runtime.scopedResourceTables()).toContainEqual({
      key: "k4",
      table: "t",
      via: 'route "r"',
    });
  });
});

// --- A8: the route drift guard ------------------------------------------------

describe("A8 — a routed loader reading a table no route names", () => {
  // The per-run capture a server's read-set sink records: this fixture's loader
  // "reads" `hosts` and, once `stray` is set, one more table.
  function drifting(strictRoutes: boolean) {
    let stray: string | null = null;
    const reports: string[] = [];
    const h = createHarness({
      reportError: (ctx) => reports.push(ctx),
      lastReadSet: () => ["hosts", ...(stray !== null ? [stray] : [])],
      strictRoutes,
    });
    h.runtime.defineResource(
      {
        key: "win",
        schema: rowsSchema,
        keyed: { keyOf },
        validateParams: () => {},
      },
      {
        routes: mintRoutePlan({
          routes: [
            {
              id: "hosts",
              table: "hosts",
              map: { kind: "identity" },
              columns: [],
            },
          ],
          usesOf: () => new Map([["hosts", { role: "membership" as const }]]),
        }),
        membership: { kind: "point", idsOf: (p) => [p.id ?? ""] },
        loader: (p) => [{ id: p.id ?? "", n: 1, tag: null, label: null }],
      },
    );
    return {
      h,
      reports,
      stray: (table: string) => {
        stray = table;
      },
    };
  }

  test("a capture within the route tables passes silently", async () => {
    const d = drifting(true);
    await d.h.subscribe("win", { id: "a" });
    expect(d.h.frames.map((f) => f.kind)).toEqual(["sub-ack"]);
    expect(d.reports).toEqual([]);
  });

  test("a drifted table is reported once per table in a running server", async () => {
    const d = drifting(false);
    d.stray("mail_accounts");
    await d.h.subscribe("win", { id: "a" });
    await d.h.subscribe("win", { id: "b" });
    expect(d.h.frames.filter((f) => f.kind === "sub-ack")).toHaveLength(2);
    expect(d.reports).toEqual(["route drift for win"]);
  });

  test("under strictRoutes (tests) the drifted load fails", async () => {
    const d = drifting(true);
    d.stray("mail_accounts");
    await d.h.subscribe("win", { id: "a" });
    expect(d.h.frames.map((f) => f.kind)).toEqual(["sub-error"]);
  });

  test("in a running server a drifted table fails open: its next change recomputes every target FULL", async () => {
    const d = drifting(false);
    d.stray("mail_accounts");
    await d.h.subscribe("win", { id: "a" });
    const before = d.h.frames.length;
    d.h.runtime.routeTableChange({
      source: "feed",
      table: "mail_accounts",
      op: "U",
      ids: ["m1"],
      keys: null,
      unchanged: null,
    });
    await settle();
    // The point tuple re-read in FULL: its value frame went out again.
    expect(d.h.frames.length).toBeGreaterThan(before);
  });
});

describe("A8 fail-open — a drifted relation reaches the entry through its bases", () => {
  test("a drifted view fails open on its base tables, never on its own name", async () => {
    const loads: ResourceParams[] = [];
    const reports: string[] = [];
    const h = createHarness({
      reportError: (ctx) => reports.push(ctx),
      lastReadSet: () => ["state", "things_v"],
      relationBases: (r) => (r === "things_v" ? ["things", "owners"] : [r]),
      strictRoutes: false,
    });
    h.runtime.defineResource(
      { key: "summary", schema: z.number(), validateParams: () => {} },
      {
        mode: "push",
        reach: mintReachPlan({
          routes: [
            {
              id: "state",
              table: "state",
              map: { kind: "full", reason: "a singleton" },
              columns: ["id"],
            },
          ],
          usesOf: () => new Map([["state", { role: "membership" as const }]]),
        }),
        loader: (p) => {
          loads.push(p);
          return loads.length;
        },
      },
    );
    await h.subscribe("summary", { id: "a" });
    expect(reports).toEqual(["route drift for summary"]);
    const change = (table: string) =>
      h.runtime.routeTableChange({
        source: "feed",
        table,
        op: "U",
        ids: ["x"],
        keys: null,
        unchanged: null,
      });
    loads.length = 0;
    change("owners");
    await settle();
    expect(loads).toEqual([{ id: "a" }]);
    loads.length = 0;
    change("things_v");
    await settle();
    expect(loads).toEqual([]);
  });
});

describe("unfed reads — a reach plan's tables read outside the change feed", () => {
  function unfedValue(unfed: readonly { table: string; reason: string }[]) {
    return mintReachPlan({
      routes: [
        {
          id: "state",
          table: "state",
          map: { kind: "full", reason: "a singleton" },
          columns: ["id"],
        },
      ],
      usesOf: () => new Map([["state", { role: "membership" as const }]]),
      unfed,
    });
  }

  test("the drift guard accepts a declared unfed table, even under strictRoutes", async () => {
    const h = createHarness({
      lastReadSet: () => ["state", "cache"],
      strictRoutes: true,
    });
    h.runtime.defineResource(
      { key: "catalog", schema: z.number(), validateParams: () => {} },
      {
        mode: "push",
        reach: unfedValue([
          { table: "cache", reason: "a memo keyed on state" },
        ]),
        loader: () => 1,
      },
    );
    await h.subscribe("catalog", {});
    expect(h.frames.map((f) => f.kind)).toEqual(["sub-ack"]);
    expect(h.runtime.unfedResourceTables()).toEqual([
      { key: "catalog", table: "cache" },
    ]);
  });

  test("minting refuses an unfed table a route names, one listed twice, or one with no reason", () => {
    expect(() => unfedValue([{ table: "state", reason: "x" }])).toThrow(
      /both routed and read outside the feed/,
    );
    expect(() =>
      unfedValue([
        { table: "cache", reason: "x" },
        { table: "cache", reason: "y" },
      ]),
    ).toThrow(/listed twice/);
    expect(() => unfedValue([{ table: "cache", reason: " " }])).toThrow(
      /no reason/,
    );
  });
});

// --- A22: derived reads (a rollup the SQL reads, routed through its sources) -

describe("A22 — a derived read is accepted when its sources are routed", () => {
  const hostsRoute = {
    id: "hosts",
    table: "hosts",
    map: { kind: "identity" as const },
    columns: [],
  };
  const sourceRoute = {
    id: "agg[events]",
    table: "events",
    map: { kind: "alias" as const, column: "host_id" },
    columns: ["host_id", "id"],
  };
  const usesOf = () =>
    new Map([
      ["hosts", { role: "membership" as const }],
      ["agg[events]", { role: "value" as const }],
    ]);

  function withDerived(capture: string[]) {
    const reports: string[] = [];
    const h = createHarness({
      reportError: (ctx) => reports.push(ctx),
      lastReadSet: () => capture,
      strictRoutes: true,
    });
    h.runtime.defineResource(
      {
        key: "win",
        schema: rowsSchema,
        keyed: { keyOf },
        validateParams: () => {},
      },
      {
        routes: mintRoutePlan({
          routes: [hostsRoute, sourceRoute],
          usesOf,
          derivedReads: [{ table: "events_agg", sources: ["events"] }],
        }),
        membership: { kind: "point", idsOf: (p) => [p.id ?? ""] },
        loader: (p) => [{ id: p.id ?? "", n: 1, tag: null, label: null }],
      },
    );
    return { h, reports };
  }

  test("a capture of the derived table passes the drift guard (A8) under strictRoutes", async () => {
    const d = withDerived(["hosts", "events_agg"]);
    await d.h.subscribe("win", { id: "a" });
    expect(d.h.frames.map((f) => f.kind)).toEqual(["sub-ack"]);
    expect(d.reports).toEqual([]);
  });

  test("a table that is neither a route nor a derived read still fails", async () => {
    const d = withDerived(["hosts", "events_agg", "other_agg"]);
    await d.h.subscribe("win", { id: "a" });
    expect(d.h.frames.map((f) => f.kind)).toEqual(["sub-error"]);
  });

  test("the derived table's sources lay out their triggers like any route; the derived table none", () => {
    const d = withDerived([]);
    expect(
      d.h.runtime.routedTableRequirements().map((r) => [r.table, r.carry]),
    ).toEqual([
      ["events", ["host_id"]],
      ["hosts", []],
    ]);
  });

  test("mintRoutePlan refuses a derived read a route names (A1)", () => {
    expect(() =>
      mintRoutePlan({
        routes: [hostsRoute, sourceRoute],
        usesOf,
        derivedReads: [{ table: "events", sources: ["hosts"] }],
      }),
    ).toThrow(/"events" is both a derived read and a route table .*\(A1\)/);
  });

  test("mintRoutePlan refuses a derived read whose source no route names (A22)", () => {
    expect(() =>
      mintRoutePlan({
        routes: [hostsRoute],
        usesOf,
        derivedReads: [{ table: "events_agg", sources: ["events"] }],
      }),
    ).toThrow(
      /derived read "events_agg" is moved by "events", which no route of the plan names .*\(A22\)/,
    );
  });

  test("mintRoutePlan refuses a derived read with no source, or listed twice", () => {
    expect(() =>
      mintRoutePlan({
        routes: [hostsRoute],
        usesOf,
        derivedReads: [{ table: "events_agg", sources: [] }],
      }),
    ).toThrow(/names no source/);
    expect(() =>
      mintRoutePlan({
        routes: [hostsRoute, sourceRoute],
        usesOf,
        derivedReads: [
          { table: "events_agg", sources: ["events"] },
          { table: "events_agg", sources: ["events"] },
        ],
      }),
    ).toThrow(/listed twice/);
  });

  test("an empty list mints no field; a reach plan cannot carry one (tsc)", () => {
    const plan = mintRoutePlan({
      routes: [hostsRoute],
      usesOf,
      derivedReads: [],
    });
    expect("derivedReads" in plan).toBe(false);
    mintReachPlan({
      routes: [
        {
          id: "base",
          table: "hosts",
          map: { kind: "full", reason: "r" },
          columns: [],
        },
      ],
      usesOf: () => new Map(),
      // @ts-expect-error — a grouping joins no rollup (C9 / D24).
      derivedReads: [{ table: "events_agg", sources: ["hosts"] }],
    });
  });
});

// --- recomputeOn: a routed entry's non-table input --------------------------

describe("recomputeOn — a routed entry's compiled vocabulary moved", () => {
  // The routed window, plus an EXTERNAL value standing for a surface's column
  // definitions (params: { scope }). Counts usesOf calls to witness the memo reset.
  function withDefs() {
    const h = createHarness();
    const loads: Array<{ params: ResourceParams; ids: string | string[] }> = [];
    let usesCalls = 0;
    const defs = h.runtime.defineExternalResource({
      key: "defs",
      mode: "push",
      schema: z.number(),
      loader: () => 1,
    });
    const plan = mintRoutePlan({
      routes: [
        {
          id: "base",
          table: "hosts",
          map: { kind: "identity" },
          columns: ["id"],
        },
      ],
      usesOf: () => {
        usesCalls++;
        return new Map<string, TupleUse>([["base", { role: "membership" }]]);
      },
    });
    h.runtime.defineResource(
      {
        key: "win",
        schema: rowsSchema,
        keyed: { keyOf },
        validateParams: () => {},
      },
      {
        routes: plan,
        recomputeOn: [{ resource: defs, params: { scope: "s" } }],
        membership: {
          kind: "window",
          windowIdsOf: async () => ["h1"],
          orderSignatureOf: () => "",
          limitOf: () => 1,
        },
        loader: async (p, c) => {
          loads.push({ params: p, ids: c ? [...c.affectedIds] : "FULL" });
          return [{ id: "h1", n: 1, tag: null, label: null }];
        },
      },
    );
    return {
      h,
      defs,
      loads,
      get usesCalls() {
        return usesCalls;
      },
    };
  }

  test("the named upstream tuple's change FULL-recomputes every subscribed tuple and drops its read-set memo", async () => {
    const f = withDefs();
    await f.h.subscribe("win", W3);
    f.h.runtime.routeTableChange({
      source: "feed",
      table: "hosts",
      op: "U",
      ids: ["h1"],
      keys: null,
      unchanged: null,
    });
    await settle();
    const usesBefore = f.usesCalls;
    const at = f.loads.length;
    f.defs.notify({ scope: "s" });
    await settle();
    expect(f.loads.slice(at)).toEqual([{ params: W3, ids: "FULL" }]);
    // The memo was dropped: the next change asks usesOf again.
    f.h.runtime.routeTableChange({
      source: "feed",
      table: "hosts",
      op: "U",
      ids: ["h1"],
      keys: null,
      unchanged: null,
    });
    await settle();
    expect(f.usesCalls).toBe(usesBefore + 1);
  });

  test("another upstream tuple reaches nothing", async () => {
    const f = withDefs();
    await f.h.subscribe("win", W3);
    const at = f.loads.length;
    f.defs.notify({ scope: "other" });
    await settle();
    expect(f.loads.slice(at)).toEqual([]);
  });

  test("refused on an unrouted entry, a DB-backed upstream, or an unregistered one", () => {
    const h = createHarness();
    const external = h.runtime.defineExternalResource({
      key: "ext",
      mode: "push",
      schema: z.number(),
      loader: () => 1,
    });
    const db = h.runtime.defineResource({
      key: "db",
      mode: "push",
      schema: z.number(),
      loader: () => 1,
    });
    const plan = mintRoutePlan({ routes: [], usesOf: () => new Map() });
    const contract = {
      key: "k",
      schema: rowsSchema,
      keyed: { keyOf },
      validateParams: () => {},
    };
    const membership = {
      kind: "window" as const,
      windowIdsOf: async () => [],
      limitOf: () => 1,
    };
    expect(() =>
      h.runtime.defineResource({
        key: "plain",
        mode: "push",
        schema: z.number(),
        loader: () => 1,
        recomputeOn: [{ resource: external, params: {} }],
      } as never),
    ).toThrow(/"recomputeOn" is for a routed entry/);
    expect(() =>
      // @ts-expect-error — a DB-backed upstream has no `notify`: a type error, and a throw past a cast.
      h.runtime.defineResource(contract, {
        routes: plan,
        membership,
        recomputeOn: [{ resource: db, params: {} }],
        loader: async () => [],
      }),
    ).toThrow(/which is DB-backed/);
    expect(() =>
      h.runtime.defineResource(
        { ...contract, key: "k2" },
        {
          routes: plan,
          membership,
          recomputeOn: [{ resource: { key: "nope" } as never, params: {} }],
          loader: async () => [],
        },
      ),
    ).toThrow(/which is not registered/);
  });
});

describe("change source", () => {
  test("a producer change refills scoped, counts as `producer` — never `feed` — and owes no ack", async () => {
    const f = routed();
    seed(f);
    await f.h.subscribe("win", W3, { acks: true });
    const before = f.h.runtime.notifyStatsFor("win");
    const at = f.loads.length;
    f.w.hosts.get("h2")!.n = 2.5;
    f.h.runtime.routeTableChange({
      source: "producer",
      table: "hosts",
      op: "U",
      ids: ["h2"],
      keys: null,
      unchanged: null,
      changedAt: Date.now(),
    });
    await settle();
    expect(f.loadsSince(at)).toEqual([{ params: W3, ids: ["h2"] }]);
    expect(f.clientValue(W3)).toEqual(f.full(W3));
    expect(f.h.runtime.notifyStatsFor("win")).toEqual({
      hand: before.hand,
      feed: before.feed,
      producer: before.producer + 1,
    });
    // No transaction to attribute: the delta carries no ack.
    expect(
      deltas(f.pushesOf(W3)).every((x) => (x.ackTx ?? []).length === 0),
    ).toBe(true);
  });
});

// --- The L2 definition (A18) ---------------------------------------------------

describe("the plan's definition (A18)", () => {
  function aliasWith(definition: string | undefined, persist: boolean) {
    const persists: Array<string | null> = [];
    const h = createHarness({
      shouldPersist: () => persist,
      captureWatermark: async () => "3",
      persistSnapshot: async (_k, _pk, _v, _w, meta) => {
        persists.push(meta.definition);
      },
    });
    h.runtime.defineResource(
      {
        key: "defd",
        schema: rowsSchema,
        keyed: { keyOf },
        validateParams: () => {},
      },
      {
        routes: mintRoutePlan({
          routes: [
            {
              id: "hosts",
              table: "hosts",
              map: { kind: "identity" },
              columns: ["id", "n"],
            },
          ],
          usesOf: () => new Map([["hosts", { role: "membership" as const }]]),
          ...(definition !== undefined ? { definition } : {}),
        }),
        scopedMembership: {
          orderOf: async () => [],
          orderSignatureOf: (r) => String((r as Row).n),
        },
        loader: () => [],
      },
    );
    return { h, persists };
  }

  test("a persisted routed entry's definition is listed and written by every persist", async () => {
    const { h, persists } = aliasWith("sql-fingerprint-1", true);
    expect(h.runtime.persistedDefinitions()).toEqual({
      defd: "sql-fingerprint-1",
    });
    h.runtime.recomputeResource("defd");
    await settle();
    expect(persists).toEqual(["sql-fingerprint-1"]);
  });

  test("a DEFERRED routed entry carries its plan's definition once bound", async () => {
    const persists: Array<string | null> = [];
    const h = createHarness({
      shouldPersist: () => true,
      captureWatermark: async () => "3",
      persistSnapshot: async (_k, _pk, _v, _w, meta) => {
        persists.push(meta.definition);
      },
    });
    h.runtime.defineDeferredResource(
      {
        key: "deferred-defd",
        schema: rowsSchema,
        keyed: { keyOf },
        validateParams: () => {},
      },
      () => ({
        routes: mintRoutePlan({
          routes: [
            {
              id: "hosts",
              table: "hosts",
              map: { kind: "identity" },
              columns: ["id", "n"],
            },
          ],
          usesOf: () => new Map([["hosts", { role: "membership" as const }]]),
          definition: "sql-fingerprint-deferred",
        }),
        scopedMembership: {
          orderOf: async () => [],
          orderSignatureOf: (r) => String((r as Row).n),
        },
        loader: () => [],
      }),
    );
    h.runtime.bindDeferredResources();
    expect(h.runtime.persistedDefinitions()).toEqual({
      "deferred-defd": "sql-fingerprint-deferred",
    });
    h.runtime.recomputeResource("deferred-defd");
    await settle();
    expect(persists).toEqual(["sql-fingerprint-deferred"]);
  });

  test("an entry that is not persisted lists no definition", () => {
    const { h } = aliasWith("sql-fingerprint-1", false);
    expect(h.runtime.persistedDefinitions()).toEqual({});
  });

  test("a routed alias without orderSignatureOf throws (an untyped caller)", () => {
    const h = createHarness();
    expect(() =>
      h.runtime.defineResource(
        {
          key: "nosig",
          schema: rowsSchema,
          keyed: { keyOf },
          validateParams: () => {},
        },
        // The routed alias arm requires orderSignatureOf (tsc) — cast past it,
        // as an untyped caller would.
        {
          routes: mintRoutePlan({
            routes: [
              {
                id: "hosts",
                table: "hosts",
                map: { kind: "identity" },
                columns: ["id"],
              },
            ],
            usesOf: () => new Map(),
          }),
          scopedMembership: { orderOf: async () => [] },
          loader: () => [],
        } as never,
      ),
    ).toThrow(/requires orderSignatureOf/);
  });
});
