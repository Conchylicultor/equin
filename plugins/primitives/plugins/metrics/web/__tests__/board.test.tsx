/**
 * The board over a fake catalog and fake answers: loading while pending, an
 * error card for a ref the catalog does not serve, tiles choosing the lead
 * card, a bucket click opening the drill-down drawer, and the card controls
 * the catalog entry allows.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

// A fixed width: jsdom lays nothing out, so the chart would never draw.
vi.mock(
  "@plugins/primitives/plugins/dom/plugins/element-size/web",
  async (importOriginal) => ({
    ...(await importOriginal<object>()),
    useElementSize: () => [() => {}, { width: 600, height: 240 }],
  }),
);
// The rail watches scroll positions jsdom does not have; it is not what these
// cases are about.
vi.mock("@plugins/primitives/plugins/outline/plugins/rail/web", () => ({
  OutlineRail: ({ entries }: { entries: { id: string }[] }) => (
    <nav data-testid="outline-rail">{entries.length}</nav>
  ),
}));
const nav = vi.hoisted(() => ({ navigate: vi.fn() }));
vi.mock("@plugins/apps-core/plugins/tabs/web", () => nav);

const PENDING = vi.hoisted(() => ({
  status: "loading" as const,
  refetch: () => Promise.resolve(),
}));
const fake = vi.hoisted(() => ({
  catalog: PENDING as unknown,
  answers: {} as Record<string, unknown>,
  details: {} as Record<string, unknown>,
  totals: {} as Record<string, unknown>,
  queries: [] as { query: unknown }[],
}));
vi.mock("../internal/use-metric", () => ({
  useMetricCatalog: () => fake.catalog,
  useMetric: (query: { metric: string }) => {
    fake.queries.push({ query });
    return fake.answers[query.metric] ?? PENDING;
  },
  useMetricDetails: (selector: { metric: string }) =>
    fake.details[selector.metric] ?? PENDING,
  useMetricDetailsTotal: (selector: { metric: string }) =>
    fake.totals[selector.metric] ?? PENDING,
  DETAILS_STEP: 5,
}));

import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { ResourceError } from "@plugins/primitives/plugins/live-state/web";
import type {
  BoardSpec,
  Catalog,
  CatalogMetric,
  SeriesResult,
} from "../../core";
import { BoardView } from "../components/board-view";
import { Delta } from "../components/delta";
import { MetricCard } from "../components/metric-card";

afterEach(() => {
  cleanup();
  localStorage.clear();
  fake.catalog = PENDING;
  fake.answers = {};
  fake.details = {};
  fake.totals = {};
  fake.queries = [];
  nav.navigate.mockClear();
});

const metric = (
  id: string,
  extra: Partial<CatalogMetric> = {},
): CatalogMetric => ({
  id: `tasks.${id}`,
  source: "tasks",
  label: id[0]!.toUpperCase() + id.slice(1),
  unit: "count",
  polarity: "up",
  measure: "flow",
  splits: [],
  params: [],
  ...extra,
});

const completed = metric("completed", {
  splits: [{ id: "category", label: "Category" }],
  drill: { label: "Completed tasks" },
});
const open = metric("open", { measure: "level", polarity: "down" });
const lead = metric("lead", {
  measure: "rate",
  polarity: "down",
  unit: "seconds",
});

const catalog: Catalog = {
  sources: [{ id: "tasks", label: "Tasks", params: [] }],
  metrics: [completed, open, lead],
  breakdowns: [],
};

const bucket = (i: number) => ({
  start: `2026-09-${String(i + 1).padStart(2, "0")}T00:00:00.000Z`,
  end: `2026-09-${String(i + 2).padStart(2, "0")}T00:00:00.000Z`,
  partial: false,
  short: `S${i}`,
  label: `Sep ${i + 1}`,
});

/** A settled read. */
function ok<T>(data: T) {
  return { status: "ready" as const, data, refetch: () => Promise.resolve() };
}

function series(
  values: number[],
  total: number,
  previousTotal: number | null = null,
) {
  const buckets = values.map((_, i) => bucket(i));
  return ok<SeriesResult>({
    kind: "series",
    buckets,
    series: [{ key: "all", label: "All", values, total }],
    total,
    previous: {
      buckets,
      values: values.map(() => 1),
      total: previousTotal,
      label: "Aug 2 – Aug 31",
    },
  });
}

const spec = (sections: BoardSpec["sections"]): BoardSpec => ({
  params: {},
  sections,
});

const focusSpec = spec([
  {
    id: "tasks",
    title: "Tasks",
    focus: {
      items: [{ metric: "tasks.completed" }, { metric: "tasks.open" }],
    },
    cards: [],
  },
]);

function renderBoard(s: BoardSpec) {
  return render(<BoardView spec={s} storageKey="test-board" viewId="main" />);
}

function tile(id: string): HTMLElement {
  return document.querySelector(`[data-metric-tile="${id}"]`)!;
}

function card(id: string): HTMLElement {
  return document.querySelector(`[data-metric-card="${id}"]`)!;
}

describe("BoardView", () => {
  it("shows Loading, never an empty board, while the catalog is pending", () => {
    renderBoard(focusSpec);
    expect(screen.getByRole("status")).toBeTruthy();
    expect(document.querySelector("[data-metric-tile]")).toBeNull();
  });

  it("shows Loading in every tile and card while their queries are pending", () => {
    fake.catalog = ok(catalog);
    renderBoard(
      spec([{ ...focusSpec.sections[0]!, cards: [{ metric: "tasks.lead" }] }]),
    );
    for (const tile of document.querySelectorAll("[data-metric-tile]")) {
      expect(within(tile as HTMLElement).getByRole("status")).toBeTruthy();
    }
    for (const id of ["tasks.completed", "tasks.lead"]) {
      expect(
        card(id).querySelector('[data-chart-state="loading"]'),
      ).not.toBeNull();
    }
    expect(document.querySelector("svg[role=img]")).toBeNull();
  });

  it("renders a failed read as its failure, with Retry, in the card's place", () => {
    fake.catalog = ok(catalog);
    const refetch = vi.fn(() => Promise.resolve());
    fake.answers["tasks.lead"] = {
      status: "error",
      error: new ResourceError("loader-failed", "query exploded", null),
      refetch,
    };
    renderBoard(spec([{ id: "s", cards: [{ metric: "tasks.lead" }] }]));
    const failed = card("tasks.lead").querySelector(
      '[data-chart-state="error"]',
    )!;
    expect(failed.textContent).toContain("query exploded");
    fireEvent.click(within(failed as HTMLElement).getByText("Retry"));
    expect(refetch).toHaveBeenCalled();
  });

  it("renders an error card for a ref the catalog does not serve", () => {
    fake.catalog = ok(catalog);
    renderBoard(
      spec([
        {
          id: "s",
          cards: [
            { metric: "tasks.nope" },
            { metric: "tasks.completed", split: "model" },
            { breakdown: "tasks.top" },
          ],
        },
      ]),
    );
    const text = document.body.textContent;
    expect(text).toContain('No metric "tasks.nope" is served');
    expect(text).toContain('Metric "tasks.completed" has no split "model"');
    expect(text).toContain('No breakdown "tasks.top" is served');
  });

  it("switches the lead card when another tile is selected", () => {
    fake.catalog = ok(catalog);
    fake.answers["tasks.completed"] = series([1, 2, 3], 6, 3);
    fake.answers["tasks.open"] = series([4, 5, 6], 6, 8);
    renderBoard(focusSpec);

    const first = tile("tasks.completed");
    const second = tile("tasks.open");
    // The first focus item leads by default.
    expect(first.getAttribute("aria-pressed")).toBe("true");
    expect(second.getAttribute("aria-pressed")).toBe("false");
    expect(card("tasks.completed")).not.toBeNull();
    expect(card("tasks.open")).toBeNull();

    fireEvent.click(second);
    expect(second.getAttribute("aria-pressed")).toBe("true");
    expect(card("tasks.open")).not.toBeNull();
    expect(card("tasks.completed")).toBeNull();
  });

  it("opens the drill-down drawer on a bucket click, listing its records", () => {
    fake.catalog = ok(catalog);
    fake.answers["tasks.completed"] = series([1, 2, 3], 6, 3);
    fake.answers["tasks.open"] = series([4, 5, 6], 6, 8);
    fake.details["tasks.completed"] = {
      ...ok([
        {
          id: "t1",
          title: "Fix the rail",
          at: "2026-09-01T10:00:00.000Z",
          link: { href: "/tasks/t1" },
        },
      ]),
      canGrow: true,
      growing: false,
      loadMore: vi.fn(),
    };
    fake.totals["tasks.completed"] = ok({ total: 4 });
    renderBoard(focusSpec);

    const hit = card("tasks.completed").querySelector("[data-hit]")!;
    fireEvent.pointerMove(hit, { clientX: 1 });
    fireEvent.click(hit);

    const drawer = screen.getByRole("dialog");
    expect(within(drawer).getByText("Sep 1")).toBeTruthy();
    const group = drawer.querySelector('[data-drill-group="tasks.completed"]')!;
    expect(group.textContent).toContain("Completed tasks");
    expect(group.textContent).toContain("· 4");
    // One more step (5) holds every record: the button says how many.
    expect(within(group as HTMLElement).getByText("Show all 4 →")).toBeTruthy();
    fireEvent.click(within(group as HTMLElement).getByText("Fix the rail"));
    expect(nav.navigate).toHaveBeenCalledWith("/tasks/t1");
  });

  it('a drawer at its cap reads "first N of total"; a total not known yet is pending, never 0', () => {
    fake.catalog = ok(catalog);
    fake.answers["tasks.completed"] = series([1, 2, 3], 6, 3);
    fake.answers["tasks.open"] = series([4, 5, 6], 6, 8);
    fake.details["tasks.completed"] = {
      ...ok([
        { id: "t1", title: "Fix the rail", at: "2026-09-01T10:00:00.000Z" },
      ]),
      canGrow: false,
      growing: false,
      loadMore: vi.fn(),
    };
    fake.totals["tasks.completed"] = ok({ total: 900 });
    renderBoard(focusSpec);
    const hit = card("tasks.completed").querySelector("[data-hit]")!;
    fireEvent.pointerMove(hit, { clientX: 1 });
    fireEvent.click(hit);
    let group = screen
      .getByRole("dialog")
      .querySelector('[data-drill-group="tasks.completed"]')!;
    expect(group.textContent).toContain("First 1 of 900");
    expect(group.textContent).not.toContain("Show");

    cleanup();
    fake.totals = {};
    renderBoard(focusSpec);
    const again = card("tasks.completed").querySelector("[data-hit]")!;
    fireEvent.pointerMove(again, { clientX: 1 });
    fireEvent.click(again);
    group = screen
      .getByRole("dialog")
      .querySelector('[data-drill-group="tasks.completed"]')!;
    expect(group.textContent).not.toContain("·");
    expect(group.textContent).not.toContain("First");
  });

  it("a full last page holding every record the total counts offers no more", () => {
    fake.catalog = ok(catalog);
    fake.answers["tasks.completed"] = series([1, 2, 3], 6, 3);
    fake.answers["tasks.open"] = series([4, 5, 6], 6, 8);
    fake.details["tasks.completed"] = {
      ...ok([
        { id: "t1", title: "Fix the rail", at: "2026-09-01T10:00:00.000Z" },
      ]),
      // The page is full, so the read cannot tell it is the end.
      canGrow: true,
      growing: false,
      loadMore: vi.fn(),
    };
    fake.totals["tasks.completed"] = ok({ total: 1 });
    renderBoard(focusSpec);
    const hit = card("tasks.completed").querySelector("[data-hit]")!;
    fireEvent.pointerMove(hit, { clientX: 1 });
    fireEvent.click(hit);
    const group = screen
      .getByRole("dialog")
      .querySelector('[data-drill-group="tasks.completed"]')!;
    expect(group.textContent).toContain("· 1");
    expect(group.textContent).not.toContain("Show");
    expect(group.textContent).not.toContain("First");
  });

  it("shows the outline rail only once there are two sections", () => {
    fake.catalog = ok(catalog);
    renderBoard(spec([{ id: "a", cards: [] }]));
    expect(screen.queryByTestId("outline-rail")).toBeNull();
    cleanup();
    renderBoard(
      spec([
        { id: "a", cards: [] },
        { id: "b", cards: [] },
      ]),
    );
    expect(screen.getByTestId("outline-rail").textContent).toBe("2");
  });
});

describe("MetricCard controls", () => {
  const ctx = { preset: "30d" as const, params: {}, compare: false };

  function renderCard(entry: CatalogMetric) {
    fake.answers[entry.id] = series([1, 2, 3], 6, 3);
    return render(
      <MetricCard
        entry={entry}
        metricRef={{ metric: entry.id }}
        context={ctx}
        view={{}}
        onView={() => {}}
      />,
    );
  }

  it("offers Daily | Cumulative for a flow only", () => {
    renderCard(completed);
    expect(screen.getByRole("radio", { name: "Cumulative" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "By Category" })).toBeTruthy();
    cleanup();
    renderCard(open);
    expect(screen.queryByRole("radio", { name: "Cumulative" })).toBeNull();
    cleanup();
    renderCard(lead);
    expect(screen.queryByRole("radio", { name: "Cumulative" })).toBeNull();
  });

  it("asks for the previous period only when unsplit", () => {
    render(
      <MetricCard
        entry={completed}
        metricRef={{ metric: completed.id, split: "category" }}
        context={ctx}
        view={{}}
        onView={() => {}}
      />,
    );
    const q = fake.queries.at(-1)!.query as Record<string, unknown>;
    expect(q.split).toBe("category");
    expect("compare" in q).toBe(false);
  });

  it("renders an illegal display as an error card", () => {
    render(
      <MetricCard
        entry={lead}
        metricRef={{ metric: lead.id, chart: "stack" }}
        context={ctx}
        view={{}}
        onView={() => {}}
      />,
    );
    expect(screen.getByRole("alert").textContent).toContain("is a rate");
  });
});

describe("Delta", () => {
  function tone(el: HTMLElement) {
    return el.querySelector("[data-tone]")?.getAttribute("data-tone");
  }

  it("colours a change by direction × polarity", () => {
    const up = render(
      <Delta delta={{ kind: "pct", value: 0.2 }} polarity="up" vs="vs prev" />,
    );
    expect(tone(up.container)).toBe("good");
    expect(up.container.textContent).toContain("20%");
    cleanup();
    const bad = render(
      <Delta
        delta={{ kind: "pct", value: 0.2 }}
        polarity="down"
        vs="vs prev"
      />,
    );
    expect(tone(bad.container)).toBe("bad");
    cleanup();
    const down = render(
      <Delta
        delta={{ kind: "pct", value: -0.05 }}
        polarity="down"
        vs="vs prev"
      />,
    );
    expect(tone(down.container)).toBe("good");
    expect(down.container.textContent).toContain("5.0%");
    cleanup();
    const neutral = render(
      <Delta
        delta={{ kind: "pct", value: 0.5 }}
        polarity="neutral"
        vs="vs prev"
      />,
    );
    expect(tone(neutral.container)).toBe("flat");
  });

  it("says New from nothing, and only the period when either side is unknown", () => {
    const n = render(
      <Delta delta={{ kind: "new" }} polarity="up" vs="vs prev" />,
    );
    expect(n.container.textContent).toContain("New");
    expect(tone(n.container)).toBe("flat");
    cleanup();
    const none = render(
      <Delta delta={{ kind: "none" }} polarity="up" vs="vs prev" />,
    );
    expect(none.container.textContent).toBe("vs prev");
    expect(none.container.querySelector('[data-delta="none"]')).not.toBeNull();
  });
});
