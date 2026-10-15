/**
 * A paged read's pages past the stale budget, drawn by the DataView as
 * height-keeping placeholders — against a laid-out page (`mountPagedDataView`,
 * `web/testing`, `"stack"` layout): every `[data-row-key]` element stacks in
 * document order (a row its own height, a placeholder its `style.height`)
 * inside a scroller whose `scrollTop` the test drives, and an
 * IntersectionObserver that answers from that layout, as a browser does. A
 * bare test view isolates the body; each real view runs the same contract in
 * its own `paged-conformance.test.tsx`.
 *
 * - a consumer's paging: a placeholder is one element per page, as tall as
 *   its rows at the measured row pitch, drawn through `primitives/loading`;
 *   on screen it is reported to the read by its key (which subscribes the
 *   page again); rows above the viewport turning into a placeholder of
 *   another height do not move the row being read (scroll anchoring); a
 *   read whose rows sit among others' (`isPaged`) draws none, and its far
 *   pages leaving the rows above the viewport are anchored all the same;
 * - a live source scrolled deep: the rows drawn stay bounded (the live band
 *   plus the stale budget) whatever the depth, the rest standing as
 *   placeholders — every row of the read accounted for.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@plugins/primitives/plugins/log-channels/web", () => ({
  clientLog: () => {},
}));

import { act, cleanup, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { z } from "zod";
import { resetDeferredLoadStateForTests } from "@plugins/framework/plugins/web-sdk/core/testing";
import { queryKeyFor } from "@plugins/primitives/plugins/live-state/web";
import { liveCollection } from "@plugins/network/plugins/live/core";
import type {
  DataViewPaging,
  DataViewRenderProps,
  DataViewVisibleRows,
  FieldDef,
} from "../../core";
import { liveDataSource } from "../internal/live-data-source";
import type { DataViewSourceBundle } from "../internal/body-types";
import {
  consumerPaging,
  mountPagedDataView,
  PAGED_VIEWPORT_PX as VIEW,
  type PagedDataView,
} from "../testing";
import { liveNumber } from "@plugins/network/plugins/live/plugins/filter/core";

const Item = z.object({ id: z.string(), n: z.number() });
type Item = z.infer<typeof Item>;

const FIELDS: FieldDef<Item>[] = [
  { id: "n", label: "N", type: "number", value: (r) => r.n },
];

/** The one view: a row per entry, marked with its row key as every view's is. */
function TestList(props: DataViewRenderProps<unknown>): ReactElement {
  return (
    <ul data-testid="rows">
      {(props.rows as Item[]).map((r, i) => (
        <li key={props.rowKey(r, i)} data-row-key={props.rowKey(r, i)}>
          {r.id}
        </li>
      ))}
    </ul>
  );
}

/** Mount the test list over `bundle()` — re-read on every `rerender`. */
const mount = (bundle: () => DataViewSourceBundle<Item>): PagedDataView =>
  mountPagedDataView({
    view: { type: "list", component: TestList },
    bundle,
    layout: "stack",
  });

/** The in-memory origin over `rows`, paged by `paging`. */
const held = (rows: Item[], paging: DataViewPaging<Item>) => ({
  fields: FIELDS,
  rows,
  rowKey: (r: Item) => r.id,
  paging,
});

beforeEach(() => {
  resetDeferredLoadStateForTests();
});
afterEach(() => {
  cleanup();
  resetDeferredLoadStateForTests();
});

// ── A consumer's paging: what the body draws and reports ─────────────────

const items = (from: number, to: number): Item[] =>
  Array.from({ length: to - from }, (_, i) => ({
    id: `c${from + i}`,
    n: from + i,
  }));

describe("page placeholders — what the DataView draws", () => {
  it("one element per page, as tall as its rows; on screen, reported to the read by its key", async () => {
    const reports: DataViewVisibleRows[] = [];
    let rows = items(0, 10);
    let paging = consumerPaging<Item>([], [], reports);
    const view = mount(() => held(rows, paging));
    await waitFor(() => expect(view.drawnRows()).toHaveLength(10));
    view.scrollTo(0);
    await view.settle();
    // Rows c4… shown, and two far pages of 2 rows before them, one after.
    rows = items(4, 10);
    paging = consumerPaging(
      [
        { key: "page-a", rows: 2 },
        { key: "page-b", rows: 2 },
      ],
      [{ key: "page-z", rows: 3 }],
      reports,
    );
    view.rerender();
    // page-a / page-b at the room c0–c3 took (20px each); page-z, standing
    // for rows never drawn, at the pitch measured from the rows: 20px.
    expect(view.placeholders()).toEqual([
      { key: "page-a", height: "40px" },
      { key: "page-b", height: "40px" },
      { key: "page-z", height: "60px" },
    ]);
    // Never a row: drawn through the loading primitive, no field rendered.
    const first = view.element("page-a");
    expect(first.querySelector('[role="status"]')).not.toBeNull();
    expect(first.textContent).toBe("");
    expect(view.drawnRows()).toEqual(items(4, 10).map((r) => r.id));

    // At the top: the placeholders are what is on screen, named by key.
    view.scrollTo(0);
    await view.settle();
    expect(reports.at(-1)).toEqual({
      kind: "rows",
      first: "page-a",
      last: "c9",
    });
  });

  it("a page released above the viewport is drawn at exactly the room its rows took: nothing moves, nothing is anchored", async () => {
    const reports: DataViewVisibleRows[] = [];
    let rows = items(0, 10);
    let paging = consumerPaging<Item>([], [], reports);
    const view = mount(() => held(rows, paging));
    // c0–c3 are tall; the rows on screen (and so the pitch) are 20px.
    view.setRowHeight((key) =>
      ["c0", "c1", "c2", "c3"].includes(key) ? 50 : 20,
    );
    await waitFor(() => expect(view.drawnRows()).toHaveLength(10));
    // c5 at the top of the screen: 4 × 50 + 20 above it.
    view.scrollTo(220);
    await view.settle();
    expect(view.layoutOf("c5").top).toBe(0);
    expect(reports.at(-1)).toEqual({ kind: "rows", first: "c5", last: "c9" });
    view.clearScrollWrites();

    // c0–c3 released past the budget: one placeholder as tall as they were
    // (4 × 50), not 4 rows at the 20px pitch.
    rows = items(4, 10);
    paging = consumerPaging([{ key: "page-a", rows: 4 }], [], reports);
    view.rerender();
    expect(view.placeholders()).toEqual([{ key: "page-a", height: "200px" }]);
    expect(view.scrollTop()).toBe(220);
    expect(view.layoutOf("c5").top).toBe(0);
    // Held by the layout itself — the scroller was never written.
    expect(view.scrollWrites()).toBe(0);

    // And back: the page's rows land in its place — taller than they were
    // (changed while away): the reader is anchored.
    view.setRowHeight((key) =>
      ["c0", "c1", "c2", "c3"].includes(key) ? 60 : 20,
    );
    rows = items(0, 10);
    paging = consumerPaging([], [], reports);
    view.rerender();
    expect(view.placeholders()).toEqual([]);
    expect(view.scrollTop()).toBe(260);
    expect(view.layoutOf("c5").top).toBe(0);
  });

  it("several pages released at once share their rows' room row for row", async () => {
    const reports: DataViewVisibleRows[] = [];
    let rows = items(0, 10);
    let paging = consumerPaging<Item>([], [], reports);
    const view = mount(() => held(rows, paging));
    view.setRowHeight((key) => (key === "c0" ? 80 : 20));
    await waitFor(() => expect(view.drawnRows()).toHaveLength(10));
    view.scrollTo(140);
    await view.settle();
    rows = items(4, 10);
    paging = consumerPaging(
      [
        { key: "page-a", rows: 1 },
        { key: "page-b", rows: 3 },
      ],
      [],
      reports,
    );
    view.rerender();
    expect(view.placeholders()).toEqual([
      { key: "page-a", height: "80px" },
      { key: "page-b", height: "60px" },
    ]);
    expect(view.scrollTop()).toBe(140);
  });

  it("a read whose rows sit among others' (isPaged) draws no placeholder", async () => {
    const reports: DataViewVisibleRows[] = [];
    const paging = consumerPaging<Item>(
      [{ key: "page-a", rows: 2 }],
      [{ key: "page-z", rows: 2 }],
      reports,
      (r) => r.n >= 5,
    );
    const view = mount(() => held(items(0, 10), paging));
    await waitFor(() => expect(view.drawnRows()).toHaveLength(10));
    expect(view.placeholders()).toEqual([]);
  });

  it("under isPaged, the read's far pages leaving the rows above the viewport leave the row being read where it is", async () => {
    const reports: DataViewVisibleRows[] = [];
    const isPaged = () => true;
    let rows = items(0, 10);
    let paging = consumerPaging<Item>([], [], reports, isPaged);
    const view = mount(() => held(rows, paging));
    await waitFor(() => expect(view.drawnRows()).toHaveLength(10));
    view.scrollTo(100);
    await view.settle();
    expect(view.layoutOf("c5").top).toBe(0);

    // c0–c3 released past the budget: no placeholder is drawn, their rows
    // simply leave — 80px less above the reader.
    rows = items(4, 10);
    paging = consumerPaging([{ key: "page-a", rows: 4 }], [], reports, isPaged);
    view.rerender();
    expect(view.placeholders()).toEqual([]);
    expect(view.scrollTop()).toBe(20);
    expect(view.layoutOf("c5").top).toBe(0);

    // And back: the page's rows land above — still anchored.
    rows = items(0, 10);
    paging = consumerPaging([], [], reports, isPaged);
    view.rerender();
    expect(view.scrollTop()).toBe(100);
    expect(view.layoutOf("c5").top).toBe(0);
  });
});

// ── A live source scrolled deep ──────────────────────────────────────────

const TOTAL = 80;
let n = 0;
const items_ = () =>
  liveCollection(`test.data-view.page-placeholders-${n++}`, {
    row: Item,
    id: "id",
    filterable: { n: liveNumber() },
    sortable: ["n"],
    default: { orderBy: [["n", "asc"]], limit: 2 },
    maxLimit: 6,
  });

const keyOf = (i: number) => JSON.stringify([String(i), `c${i}`]);
const rankOf = (key: string) => Number((JSON.parse(key) as string[])[0]);
/** The server: each window tuple answered as Postgres would, over rows 0 … TOTAL − 1. */
function windowOf(params: Record<string, string>) {
  const after = params.after === undefined ? -1 : rankOf(params.after);
  const until = params.until === undefined ? Infinity : rankOf(params.until);
  const out = [];
  for (let i = after + 1; i < TOTAL && i <= until; i++) {
    out.push({ id: `c${i}`, n: i, $key: keyOf(i) });
    if (out.length === Number(params.limit)) break;
  }
  return out;
}

describe("page placeholders — a live source scrolled deep", () => {
  it("the rows drawn stay bounded however deep the read goes; the rest stand as placeholders", async () => {
    const c = items_();
    const source = liveDataSource(c, { searchable: [] });
    const view = mount(() => ({ fields: FIELDS, source }));
    const { notifications, queryClient } = view;
    // Every subscribed tuple is answered a tick later, as a sub-ack would.
    const observe = notifications.observe.bind(notifications);
    vi.spyOn(notifications, "observe").mockImplementation(
      (key, params = {}, ...rest) => {
        observe(key, params, ...rest);
        if (key !== c.key) return;
        setTimeout(() =>
          act(() => {
            queryClient.setQueryData(
              queryKeyFor(key, params),
              windowOf(params as Record<string, string>),
            );
          }),
        );
      },
    );
    act(() => {
      queryClient.setQueryData(
        queryKeyFor(c.key, { limit: "2" }),
        windowOf({ limit: "2" }),
      );
    });
    await waitFor(() => expect(view.drawnRows()).toEqual(["c0", "c1"]));

    // Scroll to the bottom again and again: the sentinel pages the read in,
    // and the pages left behind are released.
    const bottom = () => Math.max(0, view.contentHeight() - VIEW);
    for (let i = 0; i < 400; i++) {
      view.scrollTo(bottom());
      await act(() => new Promise<void>((resolve) => setTimeout(resolve, 20)));
      if (
        view.drawnRows().includes(`c${TOTAL - 1}`) &&
        view.placeholders().length > 0
      ) {
        break;
      }
    }
    expect(view.drawnRows()).toContain(`c${TOTAL - 1}`);
    // Held still at the bottom: the viewport settles, the far pages go.
    view.scrollTo(bottom());
    await view.settle();
    await view.settle();
    view.scrollTo(bottom());
    await view.settle();

    const shown = view.drawnRows();
    // The live band (the pages on screen ± 2, each at most 2·step rows) and
    // the stale budget (8 steps of 2 rows) — never the whole read.
    expect(shown.length).toBeLessThanOrEqual(5 * 4 + 16);
    expect(shown.at(-1)).toBe(`c${TOTAL - 1}`);
    // Every row of the read accounted for: drawn, or inside a placeholder of
    // the pitch's height per row it stands for.
    const ph = view.placeholders();
    expect(ph.length).toBeGreaterThan(0);
    const standIn = ph.reduce((sum, p) => sum + parseFloat(p.height) / 20, 0);
    expect(shown.length + standIn).toBe(TOTAL);
    // The rows drawn are the order's tail, after the placeholders.
    const firstShown = Number(shown[0]!.slice(1));
    expect(shown).toEqual(
      Array.from(
        { length: TOTAL - firstShown },
        (_, i) => `c${firstShown + i}`,
      ),
    );
    expect(view.layoutOf(ph[0]!.key!).top).toBeLessThan(
      view.layoutOf(shown[0]!).top,
    );
  }, 60_000);
});
