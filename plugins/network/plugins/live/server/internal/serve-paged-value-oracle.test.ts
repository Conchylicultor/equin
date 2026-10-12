/**
 * A paged VALUE's key-range pages against a real resource runtime: an
 * in-memory source (a list held in memory, answered by `sliceRange`) served
 * through `registerPagedValue` — the path both `serveValue`s take — each page
 * its own subscribed tuple, `notify(q)` after every change, and the pages' own
 * plan (`shared/page-plan.ts`) driven by what those tuples hold and by a
 * moving viewport, as `useLive`'s paged read drives it.
 *
 * A seeded random workload of inserts, key moves and deletes interleaves with
 * paging (`loadMore`) and viewport moves. After every step, once the runtime
 * is quiet:
 *
 * - every LIVE page holds exactly what its range answers now;
 * - no item is shown twice;
 * - a `notify(q)` re-read exactly the pages subscribed (the live ones), each
 *   once — never a released one.
 *
 * Scrolled back over every page, the items are a gap-free prefix of the whole
 * list in key order; and `checkPagedSource` holds the source to its contract
 * over every range, the cuts of deleted items included (a cut is a position).
 *
 * A page is a keyed external window (P4 of
 * research/2026-10-11-global-live-paging-unification.md): a `notify(q)`
 * reaches each live page as a keyed `delta` frame — never the whole value
 * again — and a page a split or merge mints is subscribed with its seed (the
 * slices of the pages it replaces, cut from the client views as live-state
 * cuts them), so `loadMore` loads only the new page and a merge loads nothing.
 */

import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  createHarness,
  makeClientView,
  type ClientView,
  type DeriveFrame,
  type DeriveSourceFrame,
  type Harness,
  type RecordedFrame,
} from "@plugins/framework/plugins/resource-runtime/core/testing";
import {
  LIVE_ROW_KEY,
  liveValue,
  type LiveKeyCut,
  type LiveKeyRange,
  type LivePagedParams,
} from "@plugins/network/plugins/live/core";
import {
  assemble,
  loadMore,
  reconcile,
  startPages,
  type Page,
  type PageEntry,
  type PageLimits,
  type PageObservation,
  type PagePlan,
  type PageViewport,
} from "../../shared/page-plan";
import { registerPagedValue } from "../../shared/compile-value";
import { compareRowKeys, sliceRange } from "../../shared/key-order";
import { checkPagedSource } from "../testing/check-paged-source";

const Item = z.object({ id: z.string(), at: z.string().nullable() });
type Item = z.output<typeof Item>;

let seq = 0;
const pagedValue = () =>
  liveValue(`test.live.paged-value-oracle.${seq++}`, {
    query: z.object({ list: z.string() }),
    paged: {
      item: Item,
      id: "id",
      key: { of: (i: Item) => [i.at], order: ["desc"] },
      limit: 2,
      maxLimit: 4,
    },
  });
type Value = ReturnType<typeof pagedValue>;

// No stale budget here: the oracle checks what a released page holds.
const LIMITS: PageLimits = { step: 2, maxLimit: 4, staleRows: 1_000_000 };
const QUERY = { list: "l" };

/** A deterministic PRNG (mulberry32). */
function rng(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Wire = Item & { $key: string | null };

/** The source, its served value, and the pages as `useLive` runs them. */
class Fixture {
  readonly h: Harness = createHarness();
  readonly store = new Map<string, Item>();
  /** Every page tuple loaded, by its params' JSON. */
  readonly loads: string[] = [];
  readonly notifyQuestion: (q: { list: string }) => void;
  /** One page tuple loaded through the served resource (its loader, its checks, its schema). */
  readonly load: (params: LivePagedParams) => Promise<unknown>;
  plan: PagePlan<PageEntry> = startPages(LIMITS);
  viewport: PageViewport = { kind: "measuring" };
  /** The tuples subscribed now → where its frames were read up to, and its client view. */
  private views = new Map<
    string,
    {
      params: Record<string, string>;
      from: number;
      view: ClientView;
      seq: number;
    }
  >();
  /** Derivations sent — each derived sub carries a fresh id, as live-state mints one. */
  private derivations = 0;

  constructor(readonly value: Value) {
    const { resource, compiled } = registerPagedValue(this.h.runtime, value, {
      source: "external",
      changes: "notified",
      loader: (_q, range) => {
        this.loads.push(JSON.stringify(this.paramsOfRange(range)));
        return sliceRange(value, [...this.store.values()], range);
      },
    });
    this.notifyQuestion = (q) => {
      for (const t of compiled.tuplesOf(q)) resource.notify(t);
    };
    this.load = (params) => resource.load(params);
  }

  /** A range back to its tuple (cuts re-minted as the server minted them). */
  private paramsOfRange(range: LiveKeyRange): Record<string, string> {
    const cut = (c: LiveKeyCut | null) =>
      c === null ? null : JSON.stringify([...c.key, c.id]);
    return this.value.query.encode(QUERY, {
      after: cut(range.after),
      until: cut(range.until),
      limit: range.limit,
    });
  }

  paramsOf(page: Page): Record<string, string> {
    return this.value.query.encode(QUERY, page);
  }

  /** What a subscribed tuple holds: its client view, every frame for it applied. */
  private viewOf(params: Record<string, string>) {
    const k = JSON.stringify(params);
    const entry = this.views.get(k);
    if (entry === undefined) return undefined;
    const frames: RecordedFrame[] = this.h.frames;
    for (const f of frames.slice(entry.from)) {
      if (f.key !== this.value.key) continue;
      if (JSON.stringify((f as { params?: unknown }).params ?? {}) !== k) {
        continue;
      }
      entry.view.apply(f);
      // The frame stream's own order: the page applied last holds the
      // freshest value (the client's apply sequence).
      if (f.version !== undefined) entry.seq = f.seq + 1;
    }
    entry.from = frames.length;
    return entry;
  }

  /** What a subscribed tuple holds now (`undefined` until its first value). */
  valueOf(params: Record<string, string>): Wire[] | undefined {
    return this.viewOf(params)?.view.value as Wire[] | undefined;
  }

  observe = (page: Page): PageObservation<PageEntry> => {
    const value = this.valueOf(this.paramsOf(page));
    if (value === undefined) return { kind: "pending" };
    return {
      kind: "settled",
      error: null,
      appliedSeq: this.viewOf(this.paramsOf(page))!.seq,
      entries: value.map((r) => ({ id: r.id, key: r[LIVE_ROW_KEY] })),
    };
  };

  /** Subscribe every live page's tuple — seeded where its plan page says so — and release the rest. */
  async sync(): Promise<void> {
    const want = new Map(
      this.plan.pages
        .filter((p) => p.live)
        .map((p) => [JSON.stringify(this.paramsOf(p.page)), p]),
    );
    for (const [k, p] of want) {
      if (this.views.has(k)) continue;
      const params = this.paramsOf(p.page);
      const view = makeClientView();
      const derive = p.seed === null ? null : this.seedOf(p.seed);
      if (derive !== null) view.expectDerived(derive.rows, derive.frame);
      this.views.set(k, { params, from: this.h.frames.length, view, seq: 0 });
      await this.h.subscribe(
        this.value.key,
        params,
        derive !== null ? { derive: derive.frame } : {},
      );
    }
    for (const [k, { params }] of this.views) {
      if (want.has(k)) continue;
      await this.h.unsub(this.value.key, params);
      this.views.delete(k);
    }
  }

  /**
   * A seed's rows and wire derivation, cut from the source pages' views as
   * live-state cuts them from its cache — `null` when a source no longer
   * stands as the plan decided (not held, or applied since).
   */
  private seedOf(
    seed: NonNullable<PagePlan<PageEntry>["pages"][number]["seed"]>,
  ): {
    rows: Wire[];
    frame: DeriveFrame;
  } | null {
    const rows: Wire[] = [];
    const from: DeriveSourceFrame[] = [];
    for (const s of seed.from) {
      const params = this.paramsOf(s.page);
      const entry = this.viewOf(params);
      if (entry === undefined || entry.seq !== s.appliedSeq) return null;
      const held = entry.view.value as Wire[];
      const ids = held.map((r) => r.id);
      const start = s.after === null ? 0 : ids.indexOf(s.after) + 1;
      const end = s.until === null ? ids.length : ids.indexOf(s.until) + 1;
      if (
        (s.after !== null && start === 0) ||
        (s.until !== null && end === 0)
      ) {
        return null;
      }
      rows.push(...held.slice(start, end));
      from.push({
        params,
        version: entry.view.version,
        after: s.after,
        until: s.until,
      });
    }
    return { rows, frame: { id: `d${++this.derivations}`, from } };
  }

  async settle(): Promise<void> {
    for (let i = 0; i < 200; i++) {
      await this.sync();
      await this.quiet();
      const out = reconcile(this.plan, this.observe, this.viewport, LIMITS);
      if (out.plan === this.plan) return;
      this.plan = out.plan;
    }
    throw new Error("the pages never settled");
  }

  /** Until no frame lands for a few macrotasks. */
  async quiet(): Promise<void> {
    for (let stable = 0; stable < 3;) {
      const n = this.h.frames.length;
      await this.h.tick();
      stable = this.h.frames.length === n ? stable + 1 : 0;
    }
  }

  async loadMore(): Promise<void> {
    const next = loadMore(this.plan, this.observe, LIMITS);
    if (next === this.plan) return;
    this.plan = next;
    await this.settle();
  }

  ids(): string[] {
    return assemble(this.plan, this.observe).entries.map((e) => e.id);
  }

  async look(from: number, to: number): Promise<void> {
    const shown = this.ids();
    if (shown.length === 0) return;
    const a = Math.max(0, Math.min(shown.length - 1, from));
    const b = Math.max(a, Math.min(shown.length - 1, to));
    this.viewport = { kind: "rows", first: shown[a]!, last: shown[b]! };
    await this.settle();
  }

  /**
   * A change to the source: notified, and the pages settled on it. Answers
   * the tuples the notify re-read and the kinds of the frames it sent.
   */
  async change(
    mutate: () => void,
  ): Promise<{ reloaded: string[]; kinds: string[] }> {
    mutate();
    const before = this.loads.length;
    const framesAt = this.h.frames.length;
    this.notifyQuestion(QUERY);
    await this.quiet();
    const reloaded = this.loads.slice(before);
    const kinds = this.h.frames
      .slice(framesAt)
      .filter((f) => f.key === this.value.key)
      .map((f) => f.kind);
    await this.settle();
    return { reloaded, kinds };
  }

  /** The `sub-ack`s answered from a derivation so far. */
  derivedAcks(): number {
    return this.h.frames.filter(
      (f) =>
        f.kind === "sub-ack" &&
        f.key === this.value.key &&
        f.derived !== undefined,
    ).length;
  }

  subscribed(): string[] {
    return [...this.views.keys()];
  }

  /** Every live page holds exactly what its range answers now. */
  async assertLiveConverged(): Promise<void> {
    for (const p of this.plan.pages) {
      if (!p.live) continue;
      const params = this.paramsOf(p.page);
      const { range } = this.value.query.decode(params);
      const truth = sliceRange(this.value, [...this.store.values()], range);
      expect(this.valueOf(params)?.map((r) => r.id)).toEqual(
        truth.map((r) => r.id),
      );
    }
  }

  /** The whole list, in key order. */
  sorted(): Item[] {
    return sliceRange(this.value, [...this.store.values()], {
      after: null,
      until: null,
      limit: Number.MAX_SAFE_INTEGER,
    });
  }
}

const AT = ["1", "2", "3", "4", "5", null] as const;

describe("paged value — key-range pages oracle", () => {
  test("a random workload: live pages converge, nothing twice, notify re-reads the live pages only", async () => {
    const random = rng(7);
    const f = new Fixture(pagedValue());
    const deleted: LiveKeyCut[] = [];
    let next = 0;
    const pick = <T>(xs: readonly T[]): T =>
      xs[Math.floor(random() * xs.length)]!;
    for (let i = 0; i < 12; i++) {
      const id = `i${String(next++).padStart(3, "0")}`;
      f.store.set(id, { id, at: pick(AT) });
    }
    await f.settle();
    for (let step = 0; step < 120; step++) {
      const r = random();
      if (r < 0.25) {
        await f.loadMore();
      } else if (r < 0.4) {
        const n = f.ids().length;
        const at = Math.floor(random() * Math.max(1, n));
        await f.look(at, at + 1);
      } else {
        const subscribed = f.subscribed().sort();
        const { reloaded, kinds } = await f.change(() => {
          const ids = [...f.store.keys()];
          const op = random();
          if (op < 0.4 || ids.length < 4) {
            const id = `i${String(next++).padStart(3, "0")}`;
            f.store.set(id, { id, at: pick(AT) });
          } else if (op < 0.7) {
            const id = pick(ids);
            f.store.set(id, { id, at: pick(AT) });
          } else {
            const gone = f.store.get(pick(ids))!;
            f.store.delete(gone.id);
            deleted.push({ key: [gone.at], id: gone.id });
          }
        });
        // `notify(q)` re-read every subscribed page once — and nothing else —
        // and reached each as a keyed delta, never the whole value again.
        expect(reloaded.sort()).toEqual(subscribed);
        expect(kinds.filter((k) => k !== "delta")).toEqual([]);
      }
      await f.assertLiveConverged();
      const shown = f.ids();
      expect(new Set(shown).size).toBe(shown.length);
    }

    // Every page in view: a gap-free prefix of the whole list.
    f.viewport = { kind: "rows", first: f.ids()[0]!, last: f.ids().at(-1)! };
    await f.settle();
    const all = f.sorted().map((i) => i.id);
    expect(f.ids()).toEqual(all.slice(0, f.ids().length));
    while (true) {
      const before = f.ids().length;
      await f.loadMore();
      await f.look(0, Number.MAX_SAFE_INTEGER);
      if (f.ids().length === before) break;
    }
    // Capped by nothing: a viewport read pages to the end.
    expect(f.ids()).toEqual(all);

    // The source's contract, over every range — deleted items' cuts too.
    await checkPagedSource({
      value: f.value,
      query: QUERY,
      loader: (_q, range) => sliceRange(f.value, [...f.store.values()], range),
      items: [...f.store.values()],
      cuts: deleted,
    });
  }, 60_000);

  test("seeded: loadMore loads exactly the new page, a merge loads nothing, and a change after them is a delta", async () => {
    const f = new Fixture(pagedValue());
    for (let i = 0; i < 8; i++) {
      const id = `m${i}`;
      f.store.set(id, { id, at: String(9 - i) });
    }
    await f.settle();
    // Each `loadMore` reads only its new last page (`step` items); the page
    // it cut off the old last page is derived from the items the client held.
    for (let i = 0; i < 3; i++) {
      const loadsAt = f.loads.length;
      const derivedAt = f.derivedAcks();
      await f.loadMore();
      const last = f.plan.pages.at(-1)!.page;
      expect({ i, loads: f.loads.slice(loadsAt) }).toEqual({
        i,
        loads: [JSON.stringify(f.paramsOf(last))],
      });
      expect(f.derivedAcks() - derivedAt).toBe(1);
    }
    f.viewport = { kind: "rows", first: f.ids()[0]!, last: f.ids().at(-1)! };
    await f.settle();
    expect(f.ids()).toEqual(f.sorted().map((i) => i.id));
    expect(f.plan.pages.length).toBe(4);

    // Two deletes leave two neighbours one item each — they merge, and the
    // merged page is derived from both: no load at all.
    for (const id of ["m3", "m5"]) {
      const { kinds } = await f.change(() => f.store.delete(id));
      expect(kinds.filter((k) => k !== "delta")).toEqual([]);
    }
    expect(f.plan.pages.length).toBe(3);
    expect(f.derivedAcks()).toBe(4);
    await f.assertLiveConverged();
    expect(f.ids()).toEqual(f.sorted().map((i) => i.id));

    // A change after the derivations reaches the derived pages as deltas.
    const { kinds } = await f.change(() =>
      f.store.set("m9", { id: "m9", at: "5" }),
    );
    expect(kinds.length).toBeGreaterThan(0);
    expect(kinds.filter((k) => k !== "delta")).toEqual([]);
    await f.assertLiveConverged();
    expect(f.ids()).toEqual(f.sorted().map((i) => i.id));
  });

  test("a cut whose item was deleted stays a valid cut: its tuple decodes and bounds its range", async () => {
    const f = new Fixture(pagedValue());
    for (const [id, at] of [
      ["a", "5"],
      ["b", "4"],
      ["c", "3"],
      ["d", "2"],
    ] as const) {
      f.store.set(id, { id, at });
    }
    const until = JSON.stringify(["4", "b"]);
    const params = f.value.query.encode(QUERY, {
      after: null,
      until,
      limit: 4,
    });
    f.store.delete("b");
    const rows = (await f.load(params)) as Wire[];
    expect(rows.map((r) => r.id)).toEqual(["a"]);
  });

  test("checkPagedSource catches a source that answers a range wrong", async () => {
    const value = pagedValue();
    const items: Item[] = [
      { id: "a", at: "3" },
      { id: "b", at: "2" },
      { id: "c", at: "1" },
    ];
    // Treats `after` as inclusive: the cut's own item is answered again.
    const inclusive = (_q: unknown, range: LiveKeyRange): Item[] => {
      const after = range.after;
      if (after === null) return sliceRange(value, items, range);
      return sliceRange(value, items, { ...range, after: null }).filter(
        (i) =>
          compareRowKeys([i.at, i.id], [...after.key, after.id], ["desc"]) >= 0,
      );
    };
    const failure = await checkPagedSource({
      value,
      query: QUERY,
      loader: inclusive,
      items,
    }).then(
      () => null,
      (err: unknown) => err,
    );
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(/outside the range asked/);
  });
});
