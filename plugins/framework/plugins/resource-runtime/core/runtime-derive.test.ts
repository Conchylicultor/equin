/**
 * Seeded derivation — a fresh `sub` carrying `derive: { id, from }`, answered from
 * rows the client and the server already hold (`deriveSub` in `runtime.ts`;
 * research/2026-10-09-global-live-key-range-pages-v2.md §4.4). Pinned here,
 * over a bounded window resource whose tuples are KEY RANGES `(after, until]`
 * read with a limit — the shape `network/live`'s paged reads subscribe:
 *
 *   - a derived sub-ack carries no value (and no etag / watermark), echoes the
 *     derivation's id, and runs no load; the view adopting its slice equals a fresh
 *     load, and later changes reach it as deltas;
 *   - every refusal falls back to the full load (a value-carrying sub-ack),
 *     counted by reason in `_debug`: a non-quiescent source, a moved version,
 *     a slice bound naming no row, a full source sliced through its end, two
 *     slices sharing a row, more rows than the new window, a tuple already
 *     held, a resource that states no `familyOf`, a source of
 *     another query (`foreign-source`), a malformed frame (no id, more than
 *     two sources), a derivation under another frame vocabulary
 *     (`protocol-skew` — a foreign `PROTOCOL`, or none named);
 *   - a merge (two sources) loads nothing — also when the sources are
 *     unsubscribed in the same burst as the derived sub;
 *   - a commit routed right after the derivation reaches the new tuple;
 *   - a derived tuple that is not full holds its whole range: a leaver runs
 *     no `windowIdsOf` and no load;
 *   - a view answered for another client's derivation adopts nothing;
 *   - the `makeClientView` convergence property under random interleavings of
 *     writes, plain and derived subs (heads, tails, merges), unsubs and
 *     flush timing: every subscribed view equals a fresh load of its tuple;
 *   - all of it again over an EXTERNAL keyed window (never routed): a
 *     `notify` ships a keyed delta, a head and a merge derive from the
 *     pages the server holds, a busy source falls back, and the same
 *     convergence property holds under random notifies.
 */

import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  createHarness,
  makeClientView,
  rng,
  tick,
  type ClientView,
  type DeriveFrame,
  type DeriveSourceFrame,
  type Harness,
} from "./test-support";
import { defineRoutedTable } from "./testing/routed-fixture";
import type { ResourceParams } from "./runtime";

const KEY = "pages";
const TABLE = "page_rows";

interface Row {
  id: string;
  n: number;
}

/** A row's position in the total order (`n`, then id) as a comparable string. */
const keyOfRow = (r: Row): string => `${String(r.n).padStart(4, "0")}|${r.id}`;

/** A page tuple: `(after, until]` in the order, at most `limit` rows. */
interface Range {
  after: string | null;
  until: string | null;
  limit: number;
}

const paramsOf = (r: Range, q?: string): ResourceParams => ({
  limit: String(r.limit),
  ...(r.after !== null ? { after: r.after } : {}),
  ...(r.until !== null ? { until: r.until } : {}),
  ...(q !== undefined ? { q } : {}),
});

/** A tuple's family: its query (`q`), whatever its range and limit. */
const familyOf = (p: ResourceParams): string => p.q ?? "";

let derivations = 0;
/** A fresh derivation id, as live-state mints one per derived sub. */
const mintId = (): string => `d${++derivations}`;

const rangeOf = (p: ResourceParams): Range => ({
  after: p.after ?? null,
  until: p.until ?? null,
  limit: Number(p.limit),
});

const inRange = (r: Range, row: Row): boolean => {
  const k = keyOfRow(row);
  return (
    (r.after === null || k > r.after) && (r.until === null || k <= r.until)
  );
};

/**
 * A simulated table and the window resource over it: the FULL loader is the
 * range's first `limit` rows, the scoped refill the requested rows still in
 * the range (no limit — the compiled shape), `windowIdsOf` the FULL ids.
 */
function pagesHarness(
  o: {
    sockets?: number;
    familyOf?: boolean;
    debounceMs?: number;
  } = {},
) {
  const table = new Map<string, number>();
  const sorted = (): Row[] =>
    [...table.entries()]
      .map(([id, n]) => ({ id, n }))
      .sort((a, b) => (keyOfRow(a) < keyOfRow(b) ? -1 : 1));
  const truth = (p: ResourceParams): Row[] => {
    const r = rangeOf(p);
    return sorted()
      .filter((row) => inRange(r, row))
      .slice(0, r.limit);
  };
  const loads: { params: string; ids: readonly string[] | "FULL" }[] = [];
  let windowIdsCalls = 0;
  const h = createHarness({ sockets: o.sockets ?? 1 });
  const t = defineRoutedTable<Row>(h, {
    key: KEY,
    table: TABLE,
    membership: "window",
    schema: z.array(z.object({ id: z.string(), n: z.number() })),
    loader: (p, ctx) => {
      loads.push({
        params: JSON.stringify(p),
        ids: ctx ? [...ctx.affectedIds] : "FULL",
      });
      if (!ctx) return truth(p);
      const r = rangeOf(p);
      return ctx.affectedIds
        .filter((id) => table.has(id))
        .map((id) => ({ id, n: table.get(id)! }))
        .filter((row) => inRange(r, row));
    },
    windowIdsOf: async (p) => {
      windowIdsCalls++;
      return truth(p).map((r) => r.id);
    },
    orderSignatureOf: (row) => String((row as Row).n),
    limitOf: (p: ResourceParams) => Number(p.limit),
    ...(o.familyOf === false ? {} : { familyOf }),
    ...(o.debounceMs !== undefined ? { debounceMs: o.debounceMs } : {}),
  });
  const write = (op: "I" | "U" | "D", id: string, n?: number) => {
    if (op === "D") table.delete(id);
    else table.set(id, n!);
    t.feed(op, [id]);
  };
  return {
    h,
    table,
    truth,
    loads,
    write,
    windowIdsCalls: () => windowIdsCalls,
  };
}

/** One client view per subscribed tuple, fed the frames sent to its socket. */
class Views {
  private views = new Map<
    string,
    { params: ResourceParams; view: ClientView; from: number; socket: number }
  >();
  constructor(private h: Harness) {}

  private sync(k: string) {
    const v = this.views.get(k)!;
    for (const f of this.h.frames.slice(v.from)) {
      if (f.socket !== v.socket || f.key !== KEY) continue;
      if (JSON.stringify(f.params ?? {}) !== k) continue;
      v.view.apply(f);
    }
    v.from = this.h.frames.length;
    return v;
  }

  /** The view of a tuple, caught up with every frame sent so far. */
  view(params: ResourceParams): ClientView | undefined {
    const k = JSON.stringify(params);
    return this.views.has(k) ? this.sync(k).view : undefined;
  }

  subscribed(): ResourceParams[] {
    return [...this.views.values()].map((v) => v.params);
  }

  /** Track a tuple's frames without sending its sub (the caller sends it). */
  track(params: ResourceParams, socket = 0): void {
    this.views.set(JSON.stringify(params), {
      params,
      view: makeClientView(),
      from: this.h.frames.length,
      socket,
    });
  }

  /** Send a sub — derived when `derive` names slices of held views — without awaiting it. */
  send(
    params: ResourceParams,
    derive?: { slices: SliceSpec[] },
    socket = 0,
  ): DeriveFrame | null {
    const k = JSON.stringify(params);
    const view = makeClientView();
    this.views.set(k, { params, view, from: this.h.frames.length, socket });
    let frame: DeriveFrame | null = null;
    if (derive !== undefined) {
      const seeded = this.slice(derive.slices);
      if (seeded !== null) {
        frame = seeded.frame;
        view.expectDerived(seeded.rows, seeded.frame);
      }
    }
    void this.h.subscribe(KEY, params, {
      socket,
      ...(frame !== null ? { derive: frame } : {}),
    });
    return frame;
  }

  /** The slice of held rows a derivation names, as live-state computes it — `null` when it cannot. */
  slice(slices: SliceSpec[]): { rows: Row[]; frame: DeriveFrame } | null {
    const rows: Row[] = [];
    const from: DeriveSourceFrame[] = [];
    for (const s of slices) {
      const v = this.view(s.params);
      if (v === undefined || !Array.isArray(v.value)) return null;
      const held = v.value as Row[];
      const ids = held.map((r) => r.id);
      const start = s.after === null ? 0 : ids.indexOf(s.after) + 1;
      const end = s.until === null ? ids.length : ids.indexOf(s.until) + 1;
      if (
        (s.after !== null && start === 0) ||
        (s.until !== null && end === 0) ||
        end < start
      ) {
        return null;
      }
      rows.push(...held.slice(start, end));
      from.push({
        params: s.params,
        version: s.version ?? v.version,
        after: s.after,
        until: s.until,
      });
    }
    return { rows, frame: { id: mintId(), from } };
  }

  unsub(params: ResourceParams): void {
    const k = JSON.stringify(params);
    const v = this.views.get(k)!;
    this.views.delete(k);
    void this.h.unsub(KEY, params, { socket: v.socket });
  }
}

interface SliceSpec {
  params: ResourceParams;
  after: string | null;
  until: string | null;
  /** Override the version sent (default: the view's). */
  version?: number;
}

const settle = async () => {
  for (let i = 0; i < 6; i++) await tick();
};

function subAckOf(h: Harness, params: ResourceParams, from = 0) {
  return h.frames
    .slice(from)
    .find(
      (f) =>
        f.kind === "sub-ack" &&
        f.key === KEY &&
        JSON.stringify(f.params) === JSON.stringify(params),
    );
}

async function debugOf(h: Harness) {
  const res = await h.runtime.handleResourceHttp(
    new Request("http://localhost/api/resources/_debug"),
    { key: "_debug" },
  );
  const body = (await res.json()) as {
    resources: {
      key: string;
      derivedSubs: number;
      deriveFallbacks: Record<string, number>;
    }[];
  };
  return body.resources.find((r) => r.key === KEY)!;
}

/** Seed rows r0..r{count-1} at n = 10·i (no feed: nothing is subscribed yet). */
function seed(table: Map<string, number>, count: number) {
  for (let i = 0; i < count; i++) table.set(`r${i}`, i * 10);
}

describe("seeded derivation — the derived path", () => {
  test("a loadMore-shaped head is derived: no load, a value-less sub-ack echoing the derivation, and the view equals a fresh load", async () => {
    const { h, table, truth, loads } = pagesHarness();
    seed(table, 6);
    const views = new Views(h);
    const tail = paramsOf({ after: null, until: null, limit: 3 });
    views.send(tail);
    await settle();
    expect(views.view(tail)!.value).toEqual(truth(tail));

    const loadsAt = loads.length;
    const framesAt = h.frames.length;
    const head = paramsOf({
      after: null,
      until: keyOfRow({ id: "r2", n: 20 }),
      limit: 6,
    });
    const sent = views.send(head, {
      slices: [{ params: tail, after: null, until: "r2" }],
    });
    await settle();
    expect(sent).not.toBeNull();
    const ack = subAckOf(h, head, framesAt)!;
    expect("value" in ack).toBe(false);
    expect("etag" in ack).toBe(false);
    expect("watermark" in ack).toBe(false);
    expect(ack.derived).toEqual({ id: sent!.id });
    expect(loads.slice(loadsAt)).toEqual([]);
    expect(views.view(head)!.value).toEqual(truth(head));
    expect((await debugOf(h)).derivedSubs).toBe(1);
  });

  test("a derived tuple that is not full holds its whole range: a leaver costs no windowIdsOf and no load", async () => {
    const { h, table, truth, loads, write, windowIdsCalls } = pagesHarness();
    seed(table, 6);
    const views = new Views(h);
    const tail = paramsOf({ after: null, until: null, limit: 3 });
    views.send(tail);
    await settle();
    // A split head: (start, r2] — 3 rows of a 6-row window, so not full.
    const head = paramsOf({
      after: null,
      until: keyOfRow({ id: "r2", n: 20 }),
      limit: 6,
    });
    views.send(head, { slices: [{ params: tail, after: null, until: "r2" }] });
    await settle();
    expect((await debugOf(h)).derivedSubs).toBe(1);
    views.unsub(tail);
    await settle();

    const idsAt = windowIdsCalls();
    const loadsAt = loads.length;
    write("D", "r1");
    await settle();
    expect(windowIdsCalls()).toBe(idsAt);
    expect(loads.slice(loadsAt)).toEqual([]); // a pure DELETE refills nothing
    expect(views.view(head)!.value).toEqual(truth(head));
  });

  test("a change after the derivation reaches the derived tuple as a delta over the copied snapshot", async () => {
    const { h, table, truth, write } = pagesHarness();
    seed(table, 6);
    const views = new Views(h);
    const tail = paramsOf({ after: null, until: null, limit: 3 });
    views.send(tail);
    await settle();
    const head = paramsOf({
      after: null,
      until: keyOfRow({ id: "r2", n: 20 }),
      limit: 6,
    });
    views.send(head, { slices: [{ params: tail, after: null, until: "r2" }] });
    await settle();
    views.unsub(tail);
    await settle();

    write("U", "r1", 11); // in place
    write("I", "x", 5); // an entrant
    write("D", "r0", undefined); // a leaver
    await settle();
    expect(views.view(head)!.value).toEqual(truth(head));
    expect(h.pushesFor(KEY).some((f) => f.kind === "delta")).toBe(true);
  });

  test("a merge of two sources not full loads nothing", async () => {
    const { h, table, truth, loads } = pagesHarness();
    seed(table, 4);
    const views = new Views(h);
    const cut = keyOfRow({ id: "r1", n: 10 });
    const a = paramsOf({ after: null, until: cut, limit: 4 });
    const b = paramsOf({ after: cut, until: null, limit: 4 });
    views.send(a);
    views.send(b);
    await settle();
    const loadsAt = loads.length;
    const merged = paramsOf({ after: null, until: null, limit: 8 });
    views.send(merged, {
      slices: [
        { params: a, after: null, until: null },
        { params: b, after: null, until: null },
      ],
    });
    await settle();
    expect(loads.slice(loadsAt)).toEqual([]);
    expect(views.view(merged)!.value).toEqual(truth(merged));
  });

  test("a merge whose sources are unsubscribed in the same burst as the derived sub still derives, and stays current", async () => {
    // The paged read's order: the seeded sub, then the sources' release, in
    // one synchronous step — the copy is taken before either unsub lands.
    const { h, table, truth, loads, write } = pagesHarness();
    seed(table, 4);
    const views = new Views(h);
    const cut = keyOfRow({ id: "r1", n: 10 });
    const a = paramsOf({ after: null, until: cut, limit: 4 });
    const b = paramsOf({ after: cut, until: null, limit: 4 });
    views.send(a);
    views.send(b);
    await settle();
    const loadsAt = loads.length;
    const framesAt = h.frames.length;
    const merged = paramsOf({ after: null, until: null, limit: 8 });
    views.send(merged, {
      slices: [
        { params: a, after: null, until: null },
        { params: b, after: null, until: null },
      ],
    });
    views.unsub(a);
    views.unsub(b);
    await settle();
    expect(subAckOf(h, merged, framesAt)!.derived).toBeDefined();
    expect(loads.slice(loadsAt)).toEqual([]);
    expect(views.view(merged)!.value).toEqual(truth(merged));

    write("U", "r0", 25); // a move across the old cut
    write("I", "x", 35);
    await settle();
    expect(views.view(merged)!.value).toEqual(truth(merged));
  });

  test("a commit routed right after the derived sub registered reaches the new tuple", async () => {
    const { h, table, truth, write } = pagesHarness();
    seed(table, 6);
    const views = new Views(h);
    const tail = paramsOf({ after: null, until: null, limit: 3 });
    views.send(tail);
    await settle();
    const head = paramsOf({
      after: null,
      until: keyOfRow({ id: "r2", n: 20 }),
      limit: 6,
    });
    // The sub's synchronous part (register + derive) runs inside `send`; the
    // write is routed before anything awaits.
    views.send(head, { slices: [{ params: tail, after: null, until: "r2" }] });
    write("I", "racer", 15);
    await settle();
    expect(subAckOf(h, head)!.derived).toBeDefined();
    expect(views.view(head)!.value).toEqual(truth(head));
    expect((views.view(head)!.value as Row[]).map((r) => r.id)).toContain(
      "racer",
    );
  });

  test("a view holding the tuple through another request adopts nothing from a derived answer", async () => {
    const { h, table, truth } = pagesHarness();
    seed(table, 6);
    const views = new Views(h);
    const tail = paramsOf({ after: null, until: null, limit: 3 });
    views.send(tail);
    await settle();
    const head = paramsOf({
      after: null,
      until: keyOfRow({ id: "r2", n: 20 }),
      limit: 6,
    });
    const sent = views.send(head, {
      slices: [{ params: tail, after: null, until: "r2" }],
    });
    await settle();
    // A second client of the same socket stream, with no derivation pending.
    const other = makeClientView();
    other.applyAll(
      h.frames.filter((f) => f.key === KEY && f.derived !== undefined),
    );
    expect(other.version).toBe(-1);
    expect(other.value).toBeUndefined();
    // One that asked another derivation of the same tuple — the same sources,
    // its own id — adopts nothing either.
    const asked = makeClientView();
    asked.expectDerived([], { id: `${sent!.id}-other` });
    asked.applyAll(h.frames.filter((f) => f.derived !== undefined));
    expect(asked.value).toBeUndefined();
    expect(views.view(head)!.value).toEqual(truth(head));
  });
});

describe("seeded derivation — every refusal falls back to a full load", () => {
  /** Derive `head` from `tail`'s slice; answer the reason it fell back (or `null` = derived). */
  async function attempt(
    o: Parameters<typeof pagesHarness>[0],
    act: (
      x: ReturnType<typeof pagesHarness> & {
        views: Views;
        tail: ResourceParams;
      },
    ) => {
      params: ResourceParams;
      slices?: SliceSpec[];
      raw?: unknown;
      /** The sub's `protocol` (default: this build's); `null` omits it. */
      protocol?: string | null;
    },
  ) {
    const x = pagesHarness(o);
    seed(x.table, 6);
    const views = new Views(x.h);
    const tail = paramsOf({ after: null, until: null, limit: 3 });
    views.send(tail);
    await settle();
    const framesAt = x.h.frames.length;
    const loadsAt = x.loads.length;
    const { params, slices, raw, protocol } = act({ ...x, views, tail });
    if (raw !== undefined) {
      // The frame as given: the client-side slice would refuse it first.
      views.track(params);
      void x.h.subscribe(KEY, params, { derive: raw as DeriveFrame });
    } else if (protocol !== undefined) {
      // A well-formed derivation, sent under the given vocabulary.
      const seeded = views.slice(slices!)!;
      views.track(params);
      void x.h.subscribe(KEY, params, { derive: seeded.frame, protocol });
    } else {
      views.send(params, slices ? { slices } : undefined);
    }
    await settle();
    const ack = subAckOf(x.h, params, framesAt)!;
    const full = x.loads
      .slice(loadsAt)
      .filter((l) => l.ids === "FULL" && l.params === JSON.stringify(params));
    const debug = await debugOf(x.h);
    return {
      derived: ack.derived !== undefined,
      hasValue: "value" in ack,
      fullLoads: full.length,
      fallbacks: debug.deriveFallbacks,
      converged:
        JSON.stringify(views.view(params)!.value) ===
        JSON.stringify(x.truth(params)),
    };
  }

  const head = paramsOf({
    after: null,
    until: keyOfRow({ id: "r2", n: 20 }),
    limit: 6,
  });

  test("a source with a change pending (not quiescent)", async () => {
    const out = await attempt({}, ({ write, tail }) => {
      write("U", "r0", 1);
      return {
        params: head,
        slices: [{ params: tail, after: null, until: "r2" }],
      };
    });
    expect(out).toEqual({
      derived: false,
      hasValue: true,
      fullLoads: 1,
      fallbacks: { "source-busy": 1 },
      converged: true,
    });
  });

  test("a source whose version moved past the one sliced", async () => {
    const out = await attempt({}, ({ tail }) => ({
      params: head,
      slices: [{ params: tail, after: null, until: "r2", version: 0 }],
    }));
    expect(out).toMatchObject({
      derived: false,
      hasValue: true,
      fullLoads: 1,
      fallbacks: { "source-moved": 1 },
      converged: true,
    });
  });

  test("a full source sliced through its end", async () => {
    const out = await attempt({}, ({ tail }) => ({
      params: paramsOf({
        after: keyOfRow({ id: "r0", n: 0 }),
        until: null,
        limit: 6,
      }),
      slices: [{ params: tail, after: "r0", until: null }],
    }));
    expect(out).toMatchObject({
      derived: false,
      fallbacks: { "source-full": 1 },
      converged: true,
    });
  });

  test("a slice bound naming no row of its source", async () => {
    const out = await attempt({}, ({ views, tail }) => ({
      params: head,
      raw: {
        id: mintId(),
        from: [
          {
            params: tail,
            version: views.view(tail)!.version,
            after: null,
            until: "r5",
          },
        ],
      },
    }));
    expect(out.fallbacks).toEqual({ slice: 1 });
    expect(out.converged).toBe(true);
  });

  test("slices sharing a row", async () => {
    const out = await attempt({}, ({ tail }) => ({
      params: head,
      slices: [
        { params: tail, after: null, until: "r1" },
        { params: tail, after: "r0", until: "r2" },
      ],
    }));
    expect(out.fallbacks).toEqual({ overlap: 1 });
    expect(out.converged).toBe(true);
  });

  test("more rows than the new window", async () => {
    const out = await attempt({}, ({ tail }) => ({
      params: paramsOf({
        after: null,
        until: keyOfRow({ id: "r2", n: 20 }),
        limit: 2,
      }),
      slices: [{ params: tail, after: null, until: "r2" }],
    }));
    expect(out.fallbacks).toEqual({ "over-limit": 1 });
    expect(out.converged).toBe(true);
  });

  test("a resource that states no familyOf", async () => {
    const out = await attempt({ familyOf: false }, ({ tail }) => ({
      params: head,
      slices: [{ params: tail, after: null, until: "r2" }],
    }));
    expect(out.fallbacks).toEqual({ "not-derivable": 1 });
    expect(out.converged).toBe(true);
  });

  test("a source of another query (a different family: its own order, its own signatures)", async () => {
    const out = await attempt({}, ({ tail }) => ({
      // The same range of another query: the source's rows are in ITS order.
      params: paramsOf(
        { after: null, until: keyOfRow({ id: "r2", n: 20 }), limit: 6 },
        "desc",
      ),
      slices: [{ params: tail, after: null, until: "r2" }],
    }));
    expect(out).toMatchObject({
      derived: false,
      hasValue: true,
      fullLoads: 1,
      fallbacks: { "foreign-source": 1 },
      converged: true,
    });
  });

  test("a source that is not subscribed", async () => {
    const out = await attempt({}, ({ views, tail }) => {
      const version = views.view(tail)!.version;
      views.unsub(tail);
      return {
        params: head,
        raw: {
          id: mintId(),
          from: [{ params: tail, version, after: null, until: "r2" }],
        },
      };
    });
    expect(out.fallbacks).toEqual({ "source-not-held": 1 });
    expect(out.converged).toBe(true);
  });

  test("a derivation asked under another frame vocabulary (protocol-skew), or none named", async () => {
    // The same slice derives under this build's PROTOCOL (the first test of
    // this file); under any other — or from a bundle that names none — the
    // server cannot know what the derive means, nor how the tab reads a
    // derived ack, so it loads.
    for (const protocol of ["rp-0000000000000", null]) {
      const out = await attempt({}, ({ tail }) => ({
        params: head,
        slices: [{ params: tail, after: null, until: "r2" }],
        protocol,
      }));
      expect(out).toEqual({
        derived: false,
        hasValue: true,
        fullLoads: 1,
        fallbacks: { "protocol-skew": 1 },
        converged: true,
      });
    }
  });

  test("a malformed derive", async () => {
    const out = await attempt({}, () => ({
      params: head,
      raw: { id: mintId(), from: "x" },
    }));
    expect(out.fallbacks).toEqual({ malformed: 1 });
    expect(out.converged).toBe(true);
  });

  test("a derive with no id to echo", async () => {
    const out = await attempt({}, ({ views, tail }) => ({
      params: head,
      raw: {
        from: [
          {
            params: tail,
            version: views.view(tail)!.version,
            after: null,
            until: "r2",
          },
        ],
      },
    }));
    expect(out.fallbacks).toEqual({ malformed: 1 });
    expect(out.converged).toBe(true);
  });

  test("a derive naming more sources than a merge reads", async () => {
    const out = await attempt({}, ({ views, tail }) => {
      const version = views.view(tail)!.version;
      const source = (after: string | null, until: string | null) => ({
        params: tail,
        version,
        after,
        until,
      });
      return {
        params: head,
        raw: {
          id: mintId(),
          from: [source(null, "r0"), source("r0", "r1"), source("r1", "r2")],
        },
      };
    });
    expect(out.fallbacks).toEqual({ malformed: 1 });
    expect(out.converged).toBe(true);
  });

  test("a tuple another socket already holds", async () => {
    const x = pagesHarness({ sockets: 2 });
    seed(x.table, 6);
    const views = new Views(x.h);
    const tail = paramsOf({ after: null, until: null, limit: 3 });
    views.send(tail);
    // The other socket subscribes the head first, plainly.
    void x.h.subscribe(KEY, head, { socket: 1 });
    await settle();
    views.send(head, { slices: [{ params: tail, after: null, until: "r2" }] });
    await settle();
    expect((await debugOf(x.h)).deriveFallbacks).toEqual({ held: 1 });
    expect(views.view(head)!.value).toEqual(x.truth(head));
  });
});

describe("seeded derivation — convergence under random interleavings", () => {
  for (const seedNo of [1, 2, 3, 4, 5, 6, 7, 8]) {
    test(`seed ${seedNo}: every subscribed view equals a fresh load`, async () => {
      const rand = rng(seedNo * 7919);
      const { h, table, truth, write } = pagesHarness({ sockets: 1 });
      let next = 0;
      for (let i = 0; i < 12; i++)
        table.set(`r${next++}`, Math.floor(rand() * 50));
      const views = new Views(h);
      const pick = <T>(xs: readonly T[]): T =>
        xs[Math.floor(rand() * xs.length)]!;
      const rowsOf = (p: ResourceParams): Row[] => {
        const v = views.view(p)?.value;
        return Array.isArray(v) ? (v as Row[]) : [];
      };
      const fresh = (r: Range) => {
        const p = paramsOf(r);
        return views.view(p) === undefined ? p : null;
      };
      views.send(paramsOf({ after: null, until: null, limit: 3 }));
      await settle();
      let derived = 0;
      let fellBack = 0;

      for (let step = 0; step < 120; step++) {
        const roll = rand();
        const subs = views.subscribed();
        if (roll < 0.35) {
          // A write: insert, move, or delete.
          const ids = [...table.keys()];
          const w = rand();
          if (w < 0.4 || ids.length < 4)
            write("I", `r${next++}`, Math.floor(rand() * 50));
          else if (w < 0.8) write("U", pick(ids), Math.floor(rand() * 50));
          else write("D", pick(ids));
        } else if (roll < 0.45) {
          // A plain sub of a random range.
          const keys = [...table.entries()].map(([id, n]) =>
            keyOfRow({ id, n }),
          );
          const a = rand() < 0.5 ? null : pick(keys);
          const b = rand() < 0.5 ? null : pick(keys);
          const r = {
            after: a,
            until: b !== null && a !== null && b <= a ? null : b,
            limit: 1 + Math.floor(rand() * 5),
          };
          const p = fresh(r);
          if (p !== null) views.send(p);
        } else if (roll < 0.8 && subs.length > 0) {
          // A derived sub: a head, a tail, or a merge of two adjacent tuples.
          const s = pick(subs);
          const src = rangeOf(s);
          const held = rowsOf(s);
          const kind = rand();
          if (kind < 0.4 && held.length > 0) {
            const j = Math.floor(rand() * held.length);
            const p = fresh({
              after: src.after,
              until: keyOfRow(held[j]!),
              limit: 1 + Math.floor(rand() * 6),
            });
            if (p !== null) {
              views.send(p, {
                slices: [{ params: s, after: null, until: held[j]!.id }],
              });
            }
          } else if (kind < 0.7 && held.length > 0) {
            const j = Math.floor(rand() * held.length);
            const p = fresh({
              after: keyOfRow(held[j]!),
              until: src.until,
              limit: 1 + Math.floor(rand() * 6),
            });
            if (p !== null) {
              views.send(p, {
                slices: [{ params: s, after: held[j]!.id, until: null }],
              });
            }
          } else {
            const pair = subs.find((t) => {
              const tr = rangeOf(t);
              return src.until !== null && tr.after === src.until;
            });
            if (pair !== undefined) {
              const p = fresh({
                after: src.after,
                until: rangeOf(pair).until,
                limit: 2 + Math.floor(rand() * 8),
              });
              if (p !== null) {
                views.send(p, {
                  slices: [
                    { params: s, after: null, until: null },
                    { params: pair, after: null, until: null },
                  ],
                });
              }
            }
          }
        } else if (subs.length > 3) {
          views.unsub(pick(subs));
        }
        // Flush timing: sometimes the next step runs before anything drains.
        if (rand() < 0.6) await settle();
        else if (rand() < 0.5) await tick();
      }
      await settle();
      await settle();
      for (const p of views.subscribed()) {
        expect({ params: p, value: views.view(p)!.value }).toEqual({
          params: p,
          value: truth(p),
        });
      }
      const debug = await debugOf(h);
      derived += debug.derivedSubs;
      fellBack += Object.values(debug.deriveFallbacks).reduce(
        (a, b) => a + b,
        0,
      );
      // Both paths were exercised.
      expect(derived).toBeGreaterThan(0);
      expect(fellBack).toBeGreaterThan(0);
    });
  }
});

/**
 * The same pages over an EXTERNAL source (D31: never routed, but keyed — the
 * runtime's `ExternalWindowPolicy`, which `network/live` compiles a paged
 * value's pages to): no table and no routes, the change arriving as the
 * resource's own `notify(tuple)` of every live page, which re-reads the tuple
 * whole and diffs it by key (`drainMembershipFull`). So a change ships keyed
 * `delta` frames, and a page derives from the pages the server holds exactly
 * as a routed window's does.
 */
function externalPagesHarness(o: { sockets?: number } = {}) {
  const table = new Map<string, number>();
  const sorted = (): Row[] =>
    [...table.entries()]
      .map(([id, n]) => ({ id, n }))
      .sort((a, b) => (keyOfRow(a) < keyOfRow(b) ? -1 : 1));
  const truth = (p: ResourceParams): Row[] => {
    const r = rangeOf(p);
    return sorted()
      .filter((row) => inRange(r, row))
      .slice(0, r.limit);
  };
  const loads: string[] = [];
  const h = createHarness({ sockets: o.sockets ?? 1 });
  const resource = h.runtime.defineExternalResource(
    {
      key: KEY,
      schema: z.array(z.object({ id: z.string(), n: z.number() })),
      keyed: { keyOf: (r: unknown) => (r as Row).id },
      validateParams: () => {},
    },
    {
      membership: {
        kind: "window",
        limitOf: (p: ResourceParams) => Number(p.limit),
        familyOf,
      },
      loader: (p) => {
        loads.push(JSON.stringify(p));
        return truth(p);
      },
    },
  );
  /** A change to the source: its truth moves, and every live page is told. */
  const write = (views: Views, op: "I" | "U" | "D", id: string, n?: number) => {
    if (op === "D") table.delete(id);
    else table.set(id, n!);
    for (const p of views.subscribed()) resource.notify(p);
  };
  return { h, table, truth, loads, write };
}

describe("seeded derivation — an external keyed window (never routed)", () => {
  test("a notify re-reads the page and ships a keyed delta, never the whole value", async () => {
    const { h, table, truth, loads, write } = externalPagesHarness();
    seed(table, 6);
    const views = new Views(h);
    const page = paramsOf({ after: null, until: null, limit: 4 });
    views.send(page);
    await settle();
    expect(views.view(page)!.value).toEqual(truth(page));

    const framesAt = h.frames.length;
    const loadsAt = loads.length;
    write(views, "I", "x", 15); // an entrant, squeezing r3 out
    await settle();
    const sent = h.frames.slice(framesAt).filter((f) => f.key === KEY);
    expect(sent.map((f) => f.kind)).toEqual(["delta"]);
    expect(sent[0]!.upserts).toEqual([["x", { id: "x", n: 15 }]]);
    expect(sent[0]!.order).toEqual(["r0", "r1", "x", "r2"]);
    expect(loads.slice(loadsAt)).toEqual([JSON.stringify(page)]);
    expect(views.view(page)!.value).toEqual(truth(page));

    // An in-place change to a member: one upsert, no order.
    write(views, "U", "r1", 11);
    await settle();
    const last = h.pushesFor(KEY).at(-1)!;
    expect(last.kind).toBe("delta");
    expect(last.upserts).toEqual([["r1", { id: "r1", n: 11 }]]);
    expect(views.view(page)!.value).toEqual(truth(page));
  });

  test("a loadMore-shaped head is derived from a page the server holds: no load, a value-less sub-ack, later changes as deltas", async () => {
    const { h, table, truth, loads, write } = externalPagesHarness();
    seed(table, 6);
    const views = new Views(h);
    const tail = paramsOf({ after: null, until: null, limit: 3 });
    views.send(tail);
    await settle();

    const loadsAt = loads.length;
    const framesAt = h.frames.length;
    const head = paramsOf({
      after: null,
      until: keyOfRow({ id: "r2", n: 20 }),
      limit: 6,
    });
    const sent = views.send(head, {
      slices: [{ params: tail, after: null, until: "r2" }],
    });
    await settle();
    const ack = subAckOf(h, head, framesAt)!;
    expect("value" in ack).toBe(false);
    expect(ack.derived).toEqual({ id: sent!.id });
    expect(loads.slice(loadsAt)).toEqual([]);
    expect(views.view(head)!.value).toEqual(truth(head));
    expect((await debugOf(h)).derivedSubs).toBe(1);

    views.unsub(tail);
    await settle();
    write(views, "I", "x", 5);
    write(views, "D", "r0");
    await settle();
    expect(views.view(head)!.value).toEqual(truth(head));
    expect(h.pushesFor(KEY).filter((f) => f.kind === "update")).toEqual([]);
  });

  test("a merge of two external pages loads nothing", async () => {
    const { h, table, truth, loads } = externalPagesHarness();
    seed(table, 4);
    const views = new Views(h);
    const cut = keyOfRow({ id: "r1", n: 10 });
    const a = paramsOf({ after: null, until: cut, limit: 4 });
    const b = paramsOf({ after: cut, until: null, limit: 4 });
    views.send(a);
    views.send(b);
    await settle();
    const loadsAt = loads.length;
    const merged = paramsOf({ after: null, until: null, limit: 8 });
    views.send(merged, {
      slices: [
        { params: a, after: null, until: null },
        { params: b, after: null, until: null },
      ],
    });
    views.unsub(a);
    views.unsub(b);
    await settle();
    expect(loads.slice(loadsAt)).toEqual([]);
    expect(views.view(merged)!.value).toEqual(truth(merged));
  });

  test("a source with a notify pending is not quiescent: the sub falls back to a load", async () => {
    const { h, table, truth, write } = externalPagesHarness();
    seed(table, 6);
    const views = new Views(h);
    const tail = paramsOf({ after: null, until: null, limit: 3 });
    views.send(tail);
    await settle();
    const head = paramsOf({
      after: null,
      until: keyOfRow({ id: "r2", n: 20 }),
      limit: 6,
    });
    write(views, "U", "r0", 1);
    views.send(head, { slices: [{ params: tail, after: null, until: "r2" }] });
    await settle();
    expect((await debugOf(h)).deriveFallbacks).toEqual({ "source-busy": 1 });
    expect(views.view(head)!.value).toEqual(truth(head));
  });

  for (const seedNo of [1, 2, 3, 4]) {
    test(`seed ${seedNo}: every subscribed view equals a fresh load under random notifies, derived subs and unsubs`, async () => {
      const rand = rng(seedNo * 104729);
      const { h, table, truth, write } = externalPagesHarness();
      let next = 0;
      for (let i = 0; i < 12; i++)
        table.set(`r${next++}`, Math.floor(rand() * 50));
      const views = new Views(h);
      const pick = <T>(xs: readonly T[]): T =>
        xs[Math.floor(rand() * xs.length)]!;
      const rowsOf = (p: ResourceParams): Row[] => {
        const v = views.view(p)?.value;
        return Array.isArray(v) ? (v as Row[]) : [];
      };
      const fresh = (r: Range) => {
        const p = paramsOf(r);
        return views.view(p) === undefined ? p : null;
      };
      views.send(paramsOf({ after: null, until: null, limit: 3 }));
      await settle();

      for (let step = 0; step < 100; step++) {
        const roll = rand();
        const subs = views.subscribed();
        if (roll < 0.35) {
          const ids = [...table.keys()];
          const w = rand();
          if (w < 0.4 || ids.length < 4)
            write(views, "I", `r${next++}`, Math.floor(rand() * 50));
          else if (w < 0.8)
            write(views, "U", pick(ids), Math.floor(rand() * 50));
          else write(views, "D", pick(ids));
        } else if (roll < 0.75 && subs.length > 0) {
          // A derived head or tail of a held page.
          const s = pick(subs);
          const src = rangeOf(s);
          const held = rowsOf(s);
          if (held.length === 0) continue;
          const j = Math.floor(rand() * held.length);
          const head = rand() < 0.5;
          const p = fresh(
            head
              ? {
                  after: src.after,
                  until: keyOfRow(held[j]!),
                  limit: 1 + Math.floor(rand() * 6),
                }
              : {
                  after: keyOfRow(held[j]!),
                  until: src.until,
                  limit: 1 + Math.floor(rand() * 6),
                },
          );
          if (p !== null) {
            views.send(p, {
              slices: [
                head
                  ? { params: s, after: null, until: held[j]!.id }
                  : { params: s, after: held[j]!.id, until: null },
              ],
            });
          }
        } else if (subs.length > 3) {
          views.unsub(pick(subs));
        }
        if (rand() < 0.6) await settle();
        else if (rand() < 0.5) await tick();
      }
      await settle();
      await settle();
      for (const p of views.subscribed()) {
        expect({ params: p, value: views.view(p)!.value }).toEqual({
          params: p,
          value: truth(p),
        });
      }
      expect((await debugOf(h)).derivedSubs).toBeGreaterThan(0);
    });
  }
});
