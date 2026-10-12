/**
 * The paged read's plan, against a simulated server: a total order of rows
 * (each row's key is its position's text, so cuts compare like the real
 * `$key`), and every live page's window answered as Postgres would — the
 * first `limit` rows of `(after, until]`. Each answer that changes is a newly
 * applied value (a higher `appliedSeq`). The plan is driven to a fixpoint
 * after each step, as `useLive`'s paged read drives it (one reconcile per render).
 *
 * Run: `./singularity test plugins/network/plugins/live`.
 */

import { describe, expect, test } from "bun:test";
import {
  assemble,
  loadMore,
  pageKey,
  placeholderKey,
  reconcile,
  startPages,
  type Page,
  type PageEntry,
  type PageLimits,
  type PageObservation,
  type PagePlan,
  type PageViewport,
} from "./page-plan";

// H 2, M 2H — and no stale budget (its own suite below sets one).
const LIMITS: PageLimits = { step: 2, maxLimit: 4, staleRows: 1_000_000 };

/** A row in the order: `rank` places it; its key is null for an un-cuttable row. */
interface SimRow {
  id: string;
  rank: number;
  cuttable: boolean;
}

type Plan = PagePlan<PageEntry>;
type Obs = PageObservation<PageEntry>;

class Server {
  rows: SimRow[] = [];
  /** Pages whose read has not answered yet, by signature. */
  withholding = new Set<string>();
  /** Pages whose read fails, by signature. */
  failing = new Set<string>();
  /** Every page observed, by signature — what the plan read. */
  observed = new Set<string>();
  private answers = new Map<string, { json: string; obs: Obs }>();
  private seq = 0;

  constructor(ranks: number[]) {
    for (const r of ranks) this.insert(r);
  }
  has(rank: number): boolean {
    return this.rows.some((r) => r.rank === rank);
  }
  insert(rank: number, cuttable = true, id = `r${rank}`): void {
    if (this.has(rank)) throw new Error(`rank ${rank} is taken`);
    if (this.rows.some((r) => r.id === id)) throw new Error(`${id} is taken`);
    this.rows.push({ id, rank, cuttable });
    this.rows.sort((a, b) => a.rank - b.rank);
  }
  delete(rank: number): void {
    this.rows = this.rows.filter((r) => r.rank !== rank);
  }
  /** Move a row to another rank — its sort key changed. */
  move(from: number, to: number): void {
    const row = this.rows.find((r) => r.rank === from)!;
    row.rank = to;
    this.rows.sort((a, b) => a.rank - b.rank);
  }
  static keyOf(r: SimRow): string {
    return JSON.stringify([String(r.rank).padStart(8, "0"), r.id]);
  }
  static rankOf(key: string): number {
    return Number((JSON.parse(key) as string[])[0]);
  }
  window(page: Page): SimRow[] {
    return this.rows
      .filter(
        (r) =>
          (page.after === null || r.rank > Server.rankOf(page.after)) &&
          (page.until === null || r.rank <= Server.rankOf(page.until)),
      )
      .slice(0, page.limit);
  }
  observe = (page: Page): Obs => {
    const sig = JSON.stringify(page);
    this.observed.add(sig);
    if (this.withholding.has(sig)) return { kind: "pending" };
    const prev = this.answers.get(sig);
    if (this.failing.has(sig)) {
      const error = new Error(`read failed: ${sig}`);
      return prev === undefined || prev.obs.kind !== "settled"
        ? { kind: "failed", error }
        : { ...prev.obs, error };
    }
    const rows = entries(this.window(page));
    const json = JSON.stringify(rows);
    if (prev !== undefined && prev.json === json) return prev.obs;
    const obs: Obs = {
      kind: "settled",
      entries: rows,
      error: null,
      appliedSeq: ++this.seq,
    };
    this.answers.set(sig, { json, obs });
    return obs;
  };
}

const entries = (rows: SimRow[]): PageEntry[] =>
  rows.map((r) => ({ id: r.id, key: r.cuttable ? Server.keyOf(r) : null }));

const MEASURING: PageViewport = { kind: "measuring" };

/** Reconcile to a fixpoint (bounded), collecting every collapse reason. */
function settle(
  server: Server,
  plan: Plan,
  viewport: PageViewport | null = MEASURING,
  limits: PageLimits = LIMITS,
): { plan: Plan; collapses: string[] } {
  const collapses: string[] = [];
  for (let i = 0; i < 200; i++) {
    const out = reconcile(plan, server.observe, viewport, limits);
    if (out.collapsed) collapses.push(out.collapsed.reason);
    if (out.plan === plan) return { plan, collapses };
    plan = out.plan;
  }
  throw new Error("the plan did not reach a fixpoint");
}

const ids = (server: Server, plan: Plan) =>
  assemble(plan, server.observe).entries.map((e) => e.id);
const truth = (server: Server, n: number) =>
  server.rows.slice(0, n).map((r) => r.id);
const range = (from: number, to: number) =>
  Array.from({ length: to - from }, (_, i) => from + i);
const pagesOf = (plan: Plan) => plan.pages.map((p) => p.page);
const liveOf = (plan: Plan) => plan.pages.map((p) => p.live);

/** Page while the plan can grow (every page live: no viewport). */
function scrollToEnd(server: Server, plan: Plan, max = 50): Plan {
  for (let i = 0; i < max; i++) {
    if (!assemble(plan, server.observe).canGrow) return plan;
    plan = settle(server, loadMore(plan, server.observe, LIMITS)).plan;
  }
  return plan;
}

/** The plan's invariants: contiguous cuts, and exactly the last page open-ended. */
function expectContiguous(plan: Plan): void {
  const pages = pagesOf(plan);
  expect(pages.length).toBeGreaterThan(0);
  expect(pages[0]!.after).toBeNull();
  pages.forEach((p, i) => {
    if (i > 0) expect(p.after).toBe(pages[i - 1]!.until);
    if (i === pages.length - 1) expect(p.until).toBeNull();
    else expect(p.until).not.toBeNull();
    expect(p.limit).toBeLessThanOrEqual(LIMITS.maxLimit);
  });
}

describe("page plan — loadMore is a split of the last page", () => {
  test("starts at one step; a loadMore splits the full last page at its last row", () => {
    const server = new Server(range(0, 9));
    let { plan } = settle(server, startPages(LIMITS));
    expect(pagesOf(plan)).toEqual([{ after: null, until: null, limit: 2 }]);
    expect(assemble(plan, server.observe).canGrow).toBe(true);

    server.withholding.add(
      JSON.stringify({
        after: Server.keyOf(server.rows[1]!),
        until: null,
        limit: 2,
      }),
    );
    plan = settle(server, loadMore(plan, server.observe, LIMITS)).plan;
    const cut = Server.keyOf(server.rows[1]!);
    expect(pagesOf(plan)).toEqual([
      { after: null, until: cut, limit: 4 },
      { after: cut, until: null, limit: 2 },
    ]);
    // Loading the new page: the rows shown are the old ones, the footer spins.
    let a = assemble(plan, server.observe);
    expect(a.growing).toBe(true);
    expect(a.canGrow).toBe(false);
    expect(a.entries.map((e) => e.id)).toEqual(truth(server, 2));

    server.withholding.clear();
    plan = settle(server, plan).plan;
    a = assemble(plan, server.observe);
    expect(a.growing).toBe(false);
    expect(a.canGrow).toBe(true);
    expect(ids(server, plan)).toEqual(truth(server, 4));

    plan = scrollToEnd(server, plan);
    expect(ids(server, plan)).toEqual(truth(server, 9));
    a = assemble(plan, server.observe);
    expect(a.exhausted).toBe(true);
    expect(a.canGrow).toBe(false);
    expectContiguous(plan);
    // Every page but the last holds at most H rows of a 2H read: headroom.
    for (const p of plan.pages.slice(0, -1)) {
      expect(p.page.limit).toBe(4);
      expect(server.window(p.page).length).toBeLessThanOrEqual(2);
    }
  });

  test("a last page that comes back empty merges into its predecessor", () => {
    const server = new Server(range(0, 2));
    let { plan } = settle(server, startPages(LIMITS));
    plan = settle(server, loadMore(plan, server.observe, LIMITS)).plan;
    // (k, ∞) is empty: dropped, and the last page has headroom — exhausted.
    expect(pagesOf(plan)).toEqual([{ after: null, until: null, limit: 4 }]);
    const a = assemble(plan, server.observe);
    expect(a.exhausted).toBe(true);
    expect(a.canGrow).toBe(false);
    expect(loadMore(plan, server.observe, LIMITS)).toBe(plan);
  });

  test("the depth is unbounded: pages past any segment cap", () => {
    const server = new Server(range(0, 80));
    const plan = scrollToEnd(
      server,
      settle(server, startPages(LIMITS)).plan,
      100,
    );
    expect(plan.pages.length).toBeGreaterThan(16);
    expect(ids(server, plan)).toEqual(truth(server, 80));
    expect(assemble(plan, server.observe).exhausted).toBe(true);
  });
});

describe("page plan — overflow", () => {
  test("a full page that is not last splits at its median key; the rows stay a gap-free prefix", () => {
    const server = new Server(range(0, 12).map((r) => r * 10));
    let plan = scrollToEnd(server, settle(server, startPages(LIMITS)).plan, 3);
    expect(plan.pages.length).toBeGreaterThan(2);
    // Rows inserted into the head page's range until it overflows, again and
    // again: every step leaves a gap-free prefix.
    for (const rank of [1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 12, 13]) {
      server.insert(rank);
      plan = settle(server, plan).plan;
      expectContiguous(plan);
      const shown = ids(server, plan);
      expect(new Set(shown).size).toBe(shown.length);
      expect(shown).toEqual(truth(server, shown.length));
      for (const p of plan.pages.slice(0, -1)) {
        expect(server.window(p.page).length).toBeLessThan(p.page.limit);
      }
    }
  });

  test("a split page's halves show their slice of its rows until their own reads land", () => {
    const server = new Server([10, 20, 30, 40, 50, 60]);
    let plan = scrollToEnd(server, settle(server, startPages(LIMITS)).plan, 1);
    expect(pagesOf(plan)).toHaveLength(2);
    // Fill the head page (its limit is 4): it splits. Its halves' reads have
    // not answered: only the pages of the plan before the split answer.
    server.insert(11);
    server.insert(12);
    const answered = (p: Page): Obs =>
      samePageIn(plan, p) ? server.observe(p) : { kind: "pending" };
    const out = reconcile(plan, answered, MEASURING, LIMITS);
    expect(out.plan.pages.length).toBe(3);
    expect(out.plan.pages.slice(0, 2).every((p) => p.live)).toBe(true);
    // The split is reported with its rest page — the half read whole, whose
    // read the `live-pages` log times — and only it.
    expect(out.overflowed).toEqual([out.plan.pages[1]!.page]);
    expect(out.plan.pages[1]!.seed).toBeNull();
    expect(out.plan.pages[0]!.seed).not.toBeNull();
    // Nothing more to report once its halves' reads are pending.
    expect(reconcile(out.plan, answered, MEASURING, LIMITS).overflowed).toBe(
      undefined,
    );
    const a = assemble(out.plan, answered);
    // The split head's rows: [10, 11, 12, 20] → [10, 11] + [12, 20], shown.
    expect(a.entries.map((e) => e.id)).toEqual([
      "r10",
      "r11",
      "r12",
      "r20",
      "r30",
      "r40",
    ]);
    expect(a.loaded).toBe(true);
    // Not exhausted while a half has only handed rows.
    expect(a.exhausted).toBe(false);
  });
});

function samePageIn(plan: Plan, page: Page): boolean {
  return plan.pages.some(
    (p) => JSON.stringify(p.page) === JSON.stringify(page),
  );
}

describe("page plan — no cuttable key", () => {
  test("a full last page with no cuttable row says it cannot be paged past", () => {
    const server = new Server([]);
    server.insert(1, false);
    server.insert(2, false);
    server.insert(3, false);
    const { plan } = settle(server, startPages(LIMITS));
    const a = assemble(plan, server.observe);
    expect(a.truncated).toBe("long-sort-key");
    expect(a.canGrow).toBe(false);
    expect(a.exhausted).toBe(false);
    expect(loadMore(plan, server.observe, LIMITS)).toBe(plan);
  });

  test("a loadMore cuts at the last cuttable row; the rows after it go to the new page", () => {
    const server = new Server([]);
    server.insert(1);
    server.insert(2, false);
    server.insert(3);
    let { plan } = settle(server, startPages(LIMITS));
    expect(assemble(plan, server.observe).canGrow).toBe(true);
    plan = settle(server, loadMore(plan, server.observe, LIMITS)).plan;
    expect(pagesOf(plan)[0]!.until).toBe(Server.keyOf(server.rows[0]!));
    expect(ids(server, plan)).toEqual(["r1", "r2", "r3"]);
  });

  test("a full page that is not last with no cuttable key collapses into the last page", () => {
    const server = new Server([10, 20, 30, 40]);
    let plan = scrollToEnd(server, settle(server, startPages(LIMITS)).plan);
    expect(plan.pages.length).toBeGreaterThan(1);
    // Fill the head page with rows no cut can be taken at.
    for (const r of [1, 2, 3, 4]) server.insert(r, false);
    const out = settle(server, plan);
    plan = out.plan;
    expect(out.collapses).toHaveLength(1);
    expect(plan.pages).toHaveLength(1);
    expect(plan.pages[0]!.page.until).toBeNull();
    const a = assemble(plan, server.observe);
    expect(a.entries.map((e) => e.id)).toEqual(truth(server, 4));
    expect(a.truncated).toBe("long-sort-key");
  });
});

describe("page plan — merge", () => {
  test("deletes merge small neighbours: no two adjacent pages hold ≤ H rows between them", () => {
    const server = new Server(range(0, 30));
    let plan = scrollToEnd(server, settle(server, startPages(LIMITS)).plan);
    const deep = plan.pages.length;
    for (const r of range(0, 30)) {
      if (r % 3 === 0) continue;
      server.delete(r);
      plan = settle(server, plan).plan;
      expectContiguous(plan);
      const counts = plan.pages.map((p) => server.window(p.page).length);
      for (let i = 0; i + 1 < counts.length; i++) {
        expect(counts[i]! + counts[i + 1]!).toBeGreaterThan(LIMITS.step);
      }
      expect(ids(server, plan)).toEqual(truth(server, server.rows.length));
    }
    expect(plan.pages.length).toBeLessThan(deep);
  });

  test("an emptied page always merges", () => {
    const server = new Server(range(0, 8));
    let plan = scrollToEnd(server, settle(server, startPages(LIMITS)).plan);
    const second = plan.pages[1]!.page;
    for (const r of server.window(second).map((x) => x.rank)) {
      server.delete(r);
    }
    plan = settle(server, plan).plan;
    for (const p of plan.pages.slice(0, -1)) {
      expect(server.window(p.page).length).toBeGreaterThan(0);
    }
    expect(ids(server, plan)).toEqual(truth(server, server.rows.length));
  });
});

describe("page plan — liveness follows the viewport", () => {
  /** A deep plan, one row per visible key, every page known. */
  function deep(): { server: Server; plan: Plan } {
    const server = new Server(range(0, 40));
    const plan = scrollToEnd(server, settle(server, startPages(LIMITS)).plan);
    expect(plan.pages.length).toBeGreaterThan(10);
    return { server, plan };
  }
  const rowsOn = (server: Server, plan: Plan, i: number): PageViewport => {
    const rows = server.window(plan.pages[i]!.page);
    return { kind: "rows", first: rows[0]!.id, last: rows.at(-1)!.id };
  };

  test("visible ±1 live, ±3 and beyond released; ±2 keeps what it was (hysteresis)", () => {
    const { server, plan: start } = deep();
    let plan = settle(server, start, rowsOn(server, start, 5)).plan;
    const live = liveOf(plan);
    for (let i = 0; i < live.length; i++) {
      const d = Math.abs(i - 5);
      if (d <= 2)
        expect(live[i]).toBe(true); // ±2 were live: they stay
      else expect(live[i]).toBe(false);
    }
    // One page down: page 3 (now 3 away) releases, page 8 (now 2 away) stays released.
    plan = settle(server, plan, rowsOn(server, plan, 6)).plan;
    expect(plan.pages[3]!.live).toBe(false);
    expect(plan.pages[4]!.live).toBe(true);
    expect(plan.pages[7]!.live).toBe(true);
    expect(plan.pages[8]!.live).toBe(false);
    // Back up one: nothing churns — 4..7 live as they were, 8 still released.
    plan = settle(server, plan, rowsOn(server, plan, 5)).plan;
    expect(liveOf(plan).slice(3, 9)).toEqual([
      false,
      true,
      true,
      true,
      true,
      false,
    ]);
    // Every row still shown: released pages keep theirs.
    expect(ids(server, plan)).toEqual(truth(server, 40));
  });

  test("a released page shows its held rows, stale: it does not see a change until it is live again", () => {
    const { server, plan: start } = deep();
    let plan = settle(server, start, rowsOn(server, start, 0)).plan;
    const far = plan.pages.length - 2;
    expect(plan.pages[far]!.live).toBe(false);
    const farRows = server.window(plan.pages[far]!.page).map((r) => r.rank);
    server.delete(farRows[0]!);
    plan = settle(server, plan, rowsOn(server, plan, 0)).plan;
    // Still there, held.
    expect(ids(server, plan)).toContain(`r${farRows[0]}`);
    // Scrolled to: live again, and its read drops the row.
    const visible: PageViewport = {
      kind: "rows",
      first: `r${farRows[1]}`,
      last: `r${farRows[1]}`,
    };
    plan = settle(server, plan, visible).plan;
    const at = plan.pages.findIndex((p) =>
      server.window(p.page).some((r) => r.rank === farRows[1]),
    );
    expect(plan.pages[at]!.live).toBe(true);
    expect(ids(server, plan)).not.toContain(`r${farRows[0]}`);
  });

  test("measuring changes nothing; none releases every page; an empty plan stays live", () => {
    const { server, plan: start } = deep();
    expect(settle(server, start, MEASURING).plan).toBe(start);
    const none = settle(server, start, { kind: "none" }).plan;
    expect(liveOf(none).every((l) => !l)).toBe(true);
    expect(ids(server, none)).toEqual(truth(server, 40));

    const empty = new Server([]);
    const plan = settle(empty, startPages(LIMITS), { kind: "none" }).plan;
    expect(liveOf(plan)).toEqual([true]);
  });

  test("a page with no rows of its own stays live until its read lands, whatever the viewport", () => {
    const server = new Server(range(0, 6));
    let { plan } = settle(server, startPages(LIMITS));
    const next = {
      after: Server.keyOf(server.rows[1]!),
      until: null,
      limit: 2,
    };
    server.withholding.add(JSON.stringify(next));
    plan = settle(server, loadMore(plan, server.observe, LIMITS), {
      kind: "none",
    }).plan;
    expect(plan.pages[1]!.live).toBe(true);
    expect(plan.pages[0]!.live).toBe(false);
    server.withholding.clear();
    plan = settle(server, plan, { kind: "none" }).plan;
    expect(liveOf(plan)).toEqual([false, false]);
  });

  test("a page whose read failed follows its band: released with what it shows, retried when it comes back", () => {
    const server = new Server(range(0, 6));
    let { plan } = settle(server, startPages(LIMITS));
    const next = {
      after: Server.keyOf(server.rows[1]!),
      until: null,
      limit: 2,
    };
    server.failing.add(JSON.stringify(next));
    plan = settle(server, loadMore(plan, server.observe, LIMITS)).plan;
    expect(server.observe(next).kind).toBe("failed");
    expect(plan.pages[1]!.live).toBe(true);
    // Out of view: the failed page releases too — nothing outside the band
    // stays live but a read in flight.
    plan = settle(server, plan, { kind: "none" }).plan;
    expect(liveOf(plan)).toEqual([false, false]);
    // Back in view, its read heals.
    server.failing.clear();
    plan = settle(server, plan, {
      kind: "rows",
      first: "r0",
      last: "r0",
    }).plan;
    expect(liveOf(plan)).toEqual([true, true]);
    expect(ids(server, plan)).toEqual(truth(server, 4));
  });

  test("a stale last page never pages: canGrow is a live page's, and loadMore re-subscribes it first", () => {
    const { server, plan: start } = deep();
    // Grow the read so its last page is full again.
    for (const r of range(40, 50)) server.insert(r);
    let plan = settle(server, start, rowsOn(server, start, 0)).plan;
    const last = plan.pages.length - 1;
    expect(plan.pages[last]!.live).toBe(false);
    expect(assemble(plan, server.observe).canGrow).toBe(false);
    const resubscribed = loadMore(plan, server.observe, LIMITS);
    expect(pagesOf(resubscribed)).toEqual(pagesOf(plan));
    expect(resubscribed.pages[last]!.live).toBe(true);
    plan = resubscribed;
    expect(assemble(plan, server.observe).canGrow).toBe(true);
  });
});

describe("page plan — no viewport: every page live, capped at maxLimit", () => {
  test("released pages are made live again; a fixpoint is the identity", () => {
    const server = new Server(range(0, 9));
    let plan = scrollToEnd(server, settle(server, startPages(LIMITS)).plan, 1);
    expect(plan.pages).toHaveLength(2);
    plan = settle(server, plan, { kind: "none" }).plan;
    expect(liveOf(plan)).toEqual([false, false]);
    plan = settle(server, plan, null).plan;
    expect(liveOf(plan)).toEqual([true, true]);
    expect(reconcile(plan, server.observe, null, LIMITS).plan).toBe(plan);
    expect(ids(server, plan)).toEqual(truth(server, 4));
  });

  test("once the pages before the last hold maxLimit rows, the last goes and the one before it is open-ended", () => {
    const server = new Server(range(1, 10).map((r) => r * 10));
    let plan = scrollToEnd(server, settle(server, startPages(LIMITS)).plan, 1);
    expect(plan.pages).toHaveLength(2);
    // Inserts at the head fill page 0: it overflow-splits, and the pages
    // before the last now hold maxLimit rows between them.
    server.insert(1);
    server.insert(2);
    plan = settle(server, plan, null).plan;
    expectContiguous(plan);
    expect(liveOf(plan).every((l) => l)).toBe(true);
    const before = plan.pages
      .slice(0, -1)
      .reduce((n, p) => n + server.window(p.page).length, 0);
    expect(before).toBeLessThan(LIMITS.maxLimit);
    const shown = ids(server, plan);
    expect(shown).toEqual(truth(server, shown.length));
    // Bounded: below maxLimit before the last page, plus the last's limit.
    expect(shown.length).toBeLessThanOrEqual(
      LIMITS.maxLimit + plan.pages.at(-1)!.page.limit,
    );
  });
});

describe("page plan — dedup", () => {
  test("a row two live pages hold is shown once — where it was applied most recently, even moving backwards", () => {
    const server = new Server(range(0, 8).map((r) => r * 10));
    let plan = scrollToEnd(server, settle(server, startPages(LIMITS)).plan);
    expect(plan.pages.length).toBeGreaterThan(2);
    // r60 moves to rank 5: backwards, into the head page. The head's frame
    // lands first; the page it left still holds it.
    const left = plan.pages.findIndex((p) =>
      server.window(p.page).some((r) => r.id === "r60"),
    );
    const stale = server.observe(plan.pages[left]!.page);
    server.move(60, 5);
    const observe = (p: Page): Obs =>
      JSON.stringify(p) === JSON.stringify(plan.pages[left]!.page)
        ? stale
        : server.observe(p);
    const a = assemble(plan, observe);
    const shown = a.entries.map((e) => e.id);
    expect(shown.filter((id) => id === "r60")).toHaveLength(1);
    expect(shown.indexOf("r60")).toBe(1);
    // Once the page it left applies its own frame, nothing changes on screen.
    plan = settle(server, plan).plan;
    expect(ids(server, plan)).toEqual(truth(server, server.rows.length));
  });

  test("a live copy beats a stale one", () => {
    const server = new Server(range(0, 12).map((r) => r * 10));
    let plan = scrollToEnd(server, settle(server, startPages(LIMITS)).plan);
    const rowsOf = (i: number) => server.window(plan.pages[i]!.page);
    // Release everything past the head band, then move a released row into the head.
    const head = rowsOf(0);
    plan = settle(server, plan, {
      kind: "rows",
      first: head[0]!.id,
      last: head.at(-1)!.id,
    }).plan;
    const far = plan.pages.length - 1;
    expect(plan.pages[far]!.live).toBe(false);
    const farHeld = plan.pages[far]!.held;
    if (farHeld?.kind !== "rows") throw new Error("expected held rows");
    const moved = farHeld.entries[0]!.id;
    server.move(Number(moved.slice(1)), 1);
    plan = settle(server, plan, {
      kind: "rows",
      first: head[0]!.id,
      last: head.at(-1)!.id,
    }).plan;
    const shown = ids(server, plan);
    expect(shown.filter((id) => id === moved)).toHaveLength(1);
    expect(shown.indexOf(moved)).toBe(1);
  });
});

describe("page plan — failures", () => {
  test("a failing last page blocks paging with its own error; its rows stay", () => {
    const server = new Server(range(0, 6));
    let plan = scrollToEnd(server, settle(server, startPages(LIMITS)).plan, 1);
    const last = plan.pages.at(-1)!.page;
    server.failing.add(JSON.stringify(last));
    plan = settle(server, plan).plan;
    const a = assemble(plan, server.observe);
    expect(a.failures).toHaveLength(1);
    expect(a.failures[0]!.blocksPaging).toBe(true);
    expect(a.canGrow).toBe(false);
    expect(a.entries.map((e) => e.id)).toEqual(truth(server, 4));
  });

  test("a failing mid page under placeholders is a notice, not paging stopped: the placeholders wait for the viewport", () => {
    const server = new Server(range(0, 40));
    const start = scrollToEnd(server, settle(server, startPages(LIMITS)).plan);
    const budget: PageLimits = { ...LIMITS, staleRows: 4 };
    const rows = server.window(start.pages[10]!.page);
    const viewport: PageViewport = {
      kind: "rows",
      first: rows[0]!.id,
      last: rows.at(-1)!.id,
    };
    let plan = settle(server, start, viewport, budget).plan;
    expect(assemble(plan, server.observe).after.length).toBeGreaterThan(0);
    server.failing.add(JSON.stringify(plan.pages[9]!.page));
    plan = settle(server, plan, viewport, budget).plan;
    const a = assemble(plan, server.observe);
    expect(a.canGrow).toBe(false);
    expect(a.exhausted).toBe(false);
    expect(a.failures).toHaveLength(1);
    expect(a.failures[0]!.index).toBe(9);
    expect(a.failures[0]!.blocksPaging).toBe(false);
  });

  test("a head that fails with nothing to show is the head error", () => {
    const server = new Server(range(0, 3));
    server.failing.add(JSON.stringify({ after: null, until: null, limit: 2 }));
    const { plan } = settle(server, startPages(LIMITS));
    const a = assemble(plan, server.observe);
    expect(a.loaded).toBe(false);
    expect(a.headError?.message).toMatch(/read failed/);
  });
});

describe("page plan — random walk", () => {
  test("inserts, updates, deletes, loadMores and viewport moves keep the invariants", () => {
    let seed = 20261009;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const server = new Server(range(0, 20).map((r) => r * 5));
    let plan = settle(server, startPages(LIMITS)).plan;
    const freeRank = () => {
      for (;;) {
        const r = Math.floor(rand() * 1000);
        if (!server.has(r)) return r;
      }
    };
    const anyRow = () => server.rows[Math.floor(rand() * server.rows.length)]!;
    for (let step = 0; step < 400; step++) {
      const roll = rand();
      let viewport: PageViewport = MEASURING;
      if (roll < 0.25) server.insert(freeRank(), true, `x${step}`);
      else if (roll < 0.4 && server.rows.length > 0)
        server.delete(anyRow().rank);
      else if (roll < 0.55 && server.rows.length > 0) {
        server.move(anyRow().rank, freeRank());
      } else if (roll < 0.75) plan = loadMore(plan, server.observe, LIMITS);
      else {
        const shown = ids(server, plan);
        if (shown.length > 0) {
          const i = Math.floor(rand() * shown.length);
          viewport = {
            kind: "rows",
            first: shown[i]!,
            last: shown[Math.min(shown.length - 1, i + 2)]!,
          };
        }
      }
      plan = settle(server, plan, viewport).plan;
      expectContiguous(plan);
      const shown = ids(server, plan);
      expect(new Set(shown).size).toBe(shown.length);
    }
    // Scroll everything back into view: every page live, and the rows are
    // exactly a prefix of the order.
    plan = settle(server, plan, { kind: "measuring" }).plan;
    const all = ids(server, plan);
    plan = settle(server, plan, {
      kind: "rows",
      first: all[0]!,
      last: all.at(-1)!,
    }).plan;
    expect(liveOf(plan).every(Boolean)).toBe(true);
    const shown = ids(server, plan);
    expect(shown).toEqual(truth(server, shown.length));
  });
});

describe("page plan — the stale budget", () => {
  // Four stale rows: two of the two-row pages a deep read is made of.
  const BUDGET: PageLimits = { step: 2, maxLimit: 4, staleRows: 4 };
  const deep = () => {
    const server = new Server(range(0, 40));
    const plan = scrollToEnd(server, settle(server, startPages(LIMITS)).plan);
    expect(plan.pages.length).toBe(20);
    return { server, plan };
  };
  const rowsOn = (server: Server, plan: Plan, i: number): PageViewport => {
    const rows = server.window(plan.pages[i]!.page);
    return { kind: "rows", first: rows[0]!.id, last: rows.at(-1)!.id };
  };
  const on = (key: string): PageViewport => ({
    kind: "rows",
    first: key,
    last: key,
  });
  /** Rows the released pages hold between them. */
  const staleRows = (plan: Plan) =>
    plan.pages.reduce(
      (n, p) =>
        n + (!p.live && p.held?.kind === "rows" ? p.held.entries.length : 0),
      0,
    );
  /** Every row the plan stands for, drawn or in a placeholder. */
  const standsFor = (server: Server, plan: Plan) => {
    const a = assemble(plan, server.observe);
    const sum = (ps: readonly { size: number }[]) =>
      ps.reduce((n, p) => n + p.size, 0);
    return sum(a.before) + a.entries.length + sum(a.after);
  };

  test("released pages keep at most the budget, nearest the viewport first; the farther ones are placeholders, before and after the rows", () => {
    const { server, plan: start } = deep();
    const plan = settle(server, start, rowsOn(server, start, 10), BUDGET).plan;
    expect(staleRows(plan)).toBe(4);
    // ±1 live, ±2 kept live (they were), ±3 held stale — the budget — and
    // everything beyond a placeholder of the rows it held.
    plan.pages.forEach((p, i) => {
      const d = Math.abs(i - 10);
      if (d <= 2) expect(p.live).toBe(true);
      else if (d === 3) expect(p.held?.kind).toBe("rows");
      else {
        expect(p.live).toBe(false);
        expect(p.held).toEqual({ kind: "placeholder", size: 2 });
      }
    });
    const a = assemble(plan, server.observe);
    expect(a.before.map((p) => p.index)).toEqual(range(0, 7));
    expect(a.after.map((p) => p.index)).toEqual(range(14, 20));
    expect(a.before[0]!.key).toBe(placeholderKey(plan.pages[0]!.page));
    // The rows drawn are the order's, between the placeholders.
    expect(a.entries.map((e) => e.id)).toEqual(
      server.rows.slice(14, 28).map((r) => r.id),
    );
    expect(standsFor(server, plan)).toBe(40);
    // Not exhausted (the placeholders' rows are not held), nor can it page.
    expect(a.exhausted).toBe(false);
    expect(a.canGrow).toBe(false);
    expect(a.loaded).toBe(true);
  });

  test("nothing on screen: the pages nearest the head keep the budget", () => {
    const { server, plan: start } = deep();
    const plan = settle(server, start, { kind: "none" }, BUDGET).plan;
    expect(plan.pages.every((p) => !p.live)).toBe(true);
    expect(plan.pages.slice(0, 2).map((p) => p.held?.kind)).toEqual([
      "rows",
      "rows",
    ]);
    expect(
      plan.pages.slice(2).every((p) => p.held?.kind === "placeholder"),
    ).toBe(true);
    const a = assemble(plan, server.observe);
    expect(a.entries.map((e) => e.id)).toEqual(truth(server, 4));
    expect(a.after).toHaveLength(18);
  });

  test("a placeholder on screen is subscribed again: a placeholder until its read lands, then its rows — and what lies past the next placeholder follows it out", () => {
    const { server, plan: start } = deep();
    let plan = settle(server, start, rowsOn(server, start, 18), BUDGET).plan;
    let a = assemble(plan, server.observe);
    expect(a.before.map((p) => p.index)).toEqual(range(0, 14));
    // Flung to the head: page 0's placeholder is what is on screen.
    const head = plan.pages[0]!.page;
    const second = plan.pages[1]!.page;
    server.withholding.add(JSON.stringify(head));
    server.withholding.add(JSON.stringify(second));
    plan = settle(server, plan, on(placeholderKey(head)), BUDGET).plan;
    expect(plan.pages[0]!.live).toBe(true);
    expect(plan.pages[1]!.live).toBe(true);
    a = assemble(plan, server.observe);
    // Still drawn as placeholders (their reads have not landed) — never as
    // rows they do not have — and the old band's rows, released past page
    // 2's placeholder, are placeholders too: nothing is drawn as rows yet.
    expect(a.entries).toEqual([]);
    expect(a.before.map((p) => p.index)).toEqual(range(0, 20));
    expect(a.loaded).toBe(true);
    server.withholding.clear();
    plan = settle(server, plan, on(placeholderKey(head)), BUDGET).plan;
    a = assemble(plan, server.observe);
    expect(a.before).toEqual([]);
    expect(a.entries.map((e) => e.id)).toEqual(truth(server, 4));
    // The rows the old band held lie past page 2's placeholder: they cannot
    // join the rows drawn, and are placeholders too.
    expect(a.after.map((p) => p.index)).toEqual(range(2, 20));
    expect(standsFor(server, plan)).toBe(40);
    // Every page past the band is released: what stays live is the band's.
    expect(plan.pages.filter((p) => p.live).length).toBeLessThanOrEqual(2);
    expect(staleRows(plan)).toBeLessThanOrEqual(4);
  });

  /** What a viewport names page `i` by: its first drawn row, or its placeholder. */
  const markOf = (server: Server, plan: Plan, i: number): string => {
    const a = assemble(plan, server.observe);
    const placeholder = [...a.before, ...a.after].find((p) => p.index === i);
    return placeholder?.key ?? a.entries[a.firstOf[i]!]!.id;
  };
  /** The page a viewport mark names, by index — `undefined` once it is gone. */
  const pageOfMark = (server: Server, plan: Plan, mark: string) => {
    const a = assemble(plan, server.observe);
    const placeholder = [...a.before, ...a.after].find((p) => p.key === mark);
    if (placeholder !== undefined) return placeholder.index;
    const row = a.entries.findIndex((e) => e.id === mark);
    if (row < 0) return undefined;
    return a.firstOf.findIndex(
      (f, i) => f <= row && row < (a.firstOf[i + 1] ?? a.entries.length),
    );
  };
  /** The pages drawn as placeholders, by page identity. */
  const drawnPlaceholders = (server: Server, plan: Plan) => {
    const a = assemble(plan, server.observe);
    return new Set([...a.before, ...a.after].map((p) => pageKey(p.page)));
  };

  test("scrolling down through placeholders subscribed again keeps the budget's rows behind the viewport", () => {
    const { server, plan: start } = deep();
    let plan = settle(server, start, rowsOn(server, start, 2), BUDGET).plan;
    expect(assemble(plan, server.observe).after[0]!.index).toBe(7);
    for (let v = 3; v <= 14; v++) {
      plan = settle(server, plan, on(markOf(server, plan, v)), BUDGET).plan;
      if (v < 5) continue;
      // The pages just behind the band were subscribed again from
      // placeholders, landed and are drawn as rows: they end no side. The
      // two released pages nearest above it keep the budget's rows, and the
      // page past the band below — still a placeholder — ends that side.
      expect(plan.pages[v - 2]!.live).toBe(true);
      expect(plan.pages[v - 3]!.held?.kind).toBe("rows");
      expect(plan.pages[v - 4]!.held?.kind).toBe("rows");
      expect(staleRows(plan)).toBe(4);
      expect(plan.pages[v - 5]!.held).toEqual({ kind: "placeholder", size: 2 });
      const a = assemble(plan, server.observe);
      expect(a.entries.map((e) => e.id)).toEqual(
        server.rows.slice(2 * (v - 4), 2 * (v + 2)).map((r) => r.id),
      );
    }
  });

  test("a random walk keeps the budget, the placeholders at the edges, and every row accounted for", () => {
    let seed = 7_331;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const server = new Server(range(0, 30).map((r) => r * 5));
    let plan = settle(server, startPages(BUDGET), MEASURING, BUDGET).plan;
    const freeRank = () => {
      for (;;) {
        const r = Math.floor(rand() * 1000);
        if (!server.has(r)) return r;
      }
    };
    for (let step = 0; step < 400; step++) {
      const roll = rand();
      let viewport: PageViewport = MEASURING;
      if (roll < 0.15) server.insert(freeRank(), true, `x${step}`);
      else if (roll < 0.25 && server.rows.length > 0)
        server.delete(
          server.rows[Math.floor(rand() * server.rows.length)]!.rank,
        );
      else if (roll < 0.55) plan = loadMore(plan, server.observe, BUDGET);
      else {
        // Look somewhere: a row drawn, or a placeholder.
        const a = assemble(plan, server.observe);
        const marks = [
          ...a.before.map((p) => p.key),
          ...a.entries.map((e) => e.id),
          ...a.after.map((p) => p.key),
        ];
        if (marks.length > 0) {
          viewport = on(marks[Math.floor(rand() * marks.length)]!);
        }
      }
      const prev = plan;
      const wasDrawnAsPlaceholder = drawnPlaceholders(server, prev);
      const wasPage = new Set(prev.pages.map((p) => pageKey(p.page)));
      plan = settle(server, plan, viewport, BUDGET).plan;
      expectContiguous(plan);
      expect(staleRows(plan)).toBeLessThanOrEqual(BUDGET.staleRows);
      // A page the budget turned into a placeholder in this step either lay
      // past a page drawn as a placeholder (before or after the step) on its
      // side of the viewport, or its rows did not fit beside the stale rows
      // kept — never because a page drawn as rows was taken for one.
      if (viewport.kind === "rows") {
        const v = pageOfMark(server, plan, viewport.first);
        const isDrawnAsPlaceholder = drawnPlaceholders(server, plan);
        plan.pages.forEach((p, i) => {
          const key = pageKey(p.page);
          if (v === undefined || p.live || p.held?.kind !== "placeholder")
            return;
          if (!wasPage.has(key) || wasDrawnAsPlaceholder.has(key)) return;
          const between = range(Math.min(i, v) + 1, Math.max(i, v));
          const pastPlaceholder = between.some((j) => {
            const k = pageKey(plan.pages[j]!.page);
            return wasDrawnAsPlaceholder.has(k) || isDrawnAsPlaceholder.has(k);
          });
          if (!pastPlaceholder) {
            expect(staleRows(plan) + p.held.size).toBeGreaterThan(
              BUDGET.staleRows,
            );
          }
        });
      }
      const a = assemble(plan, server.observe);
      // Placeholders only at the edges: before = a prefix of the pages,
      // after = a suffix, the rows' pages between.
      expect(a.before.map((p) => p.index)).toEqual(range(0, a.before.length));
      expect(a.after.map((p) => p.index)).toEqual(
        range(plan.pages.length - a.after.length, plan.pages.length),
      );
      const shown = a.entries.map((e) => e.id);
      expect(new Set(shown).size).toBe(shown.length);
    }
    // Look at every page, placeholders included, until the plan holds still:
    // every page live, and the rows exactly a prefix of the order.
    for (let i = 0; i < 20; i++) {
      const a = assemble(plan, server.observe);
      const first = a.before[0]?.key ?? a.entries[0]?.id;
      const last = a.after.at(-1)?.key ?? a.entries.at(-1)?.id;
      if (first === undefined || last === undefined) break;
      plan = settle(server, plan, { kind: "rows", first, last }, BUDGET).plan;
    }
    const a = assemble(plan, server.observe);
    expect(a.before).toEqual([]);
    expect(a.after).toEqual([]);
    expect(plan.pages.every((p) => p.live)).toBe(true);
    const shown = a.entries.map((e) => e.id);
    expect(shown).toEqual(truth(server, shown.length));
  });
});
