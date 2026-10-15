import { afterEach, describe, expect, it, vi } from "vitest";

// A fixed width: jsdom lays nothing out, so the real observer would report 0
// and the chart would never draw its svg.
vi.mock(
  "@plugins/primitives/plugins/dom/plugins/element-size/web",
  async (importOriginal) => ({
    ...(await importOriginal<object>()),
    useElementSize: () => [() => {}, { width: 600, height: 240 }],
  }),
);

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ChartBucket, ChartSeries } from "../../core";
import { ChartOrTable } from "../components/chart-or-table";
import { TimeChart } from "../components/time-chart";

afterEach(cleanup);

const buckets = (n: number, partialLast = false): ChartBucket[] =>
  Array.from({ length: n }, (_, i) => ({
    short: `D${i}`,
    label: `Day ${i}`,
    partial: partialLast && i === n - 1 ? true : undefined,
  }));

const series = (key: string, values: (number | null)[]): ChartSeries => ({
  key,
  label: key.toUpperCase(),
  values,
});

// width 600 − margins (46 + 10) = 544px of plot; 4 buckets → 136px each.
const BAND = 136;

function bars(container: HTMLElement) {
  return container.querySelectorAll('[data-mark="bar"]');
}

function hit(container: HTMLElement) {
  return container.querySelector("[data-hit]")!;
}

function tooltip(container: HTMLElement) {
  return container.querySelector("[data-chart-tooltip]");
}

describe("TimeChart bars", () => {
  it("draws one bar per non-zero bucket; 0 and null draw nothing", () => {
    const { container } = render(
      <TimeChart
        label="x"
        kind="stack"
        buckets={buckets(4)}
        series={[series("a", [3, 0, null, 5])]}
      />,
    );
    expect(bars(container)).toHaveLength(2);
  });

  it("stacks one segment per positive value", () => {
    const { container } = render(
      <TimeChart
        label="x"
        kind="stack"
        buckets={buckets(4)}
        series={[series("a", [3, 1, 0, 5]), series("b", [2, 0, 4, 1])]}
      />,
    );
    expect(bars(container)).toHaveLength(6);
  });

  it("colours series by categorical slot in order", () => {
    const { container } = render(
      <TimeChart
        label="x"
        kind="stack"
        buckets={buckets(1)}
        series={[series("a", [3]), series("b", [2])]}
      />,
    );
    const fills = [...bars(container)].map((b) => b.getAttribute("fill"));
    expect(fills).toEqual(["var(--categorical-1)", "var(--categorical-2)"]);
  });

  it("draws net bars in the positive / negative tokens", () => {
    const { container } = render(
      <TimeChart
        label="x"
        kind="net"
        buckets={buckets(3)}
        series={[series("n", [4, -2, 0])]}
      />,
    );
    const fills = [...bars(container)].map((b) => b.getAttribute("fill"));
    expect(fills).toEqual(["var(--success)", "var(--destructive)"]);
  });

  it("draws a partial bucket lighter", () => {
    const { container } = render(
      <TimeChart
        label="x"
        kind="stack"
        buckets={buckets(3, true)}
        series={[series("a", [3, 4, 2])]}
      />,
    );
    const all = [...bars(container)];
    expect(all.map((b) => b.getAttribute("data-partial"))).toEqual([
      null,
      null,
      "true",
    ]);
    expect(all[2]!.getAttribute("fill-opacity")).toBe("0.45");
    expect(all[0]!.getAttribute("fill-opacity")).toBe("1");
  });
});

describe("TimeChart lines", () => {
  it("dashes the segment into a partial bucket", () => {
    const { container } = render(
      <TimeChart
        label="x"
        kind="line"
        buckets={buckets(3, true)}
        series={[series("a", [3, 4, 2])]}
      />,
    );
    const partial = container.querySelector('[data-mark="line"][data-partial]');
    expect(partial).not.toBeNull();
    expect(partial!.getAttribute("stroke-dasharray")).toBe("3 3");
  });

  it("breaks the line at a null and marks a lone value", () => {
    const { container } = render(
      <TimeChart
        label="x"
        kind="area"
        buckets={buckets(4)}
        series={[series("a", [3, null, 2, null])]}
      />,
    );
    expect(container.querySelector('[data-mark="line"]')).toBeNull();
    expect(container.querySelectorAll('[data-mark="marker"]')).toHaveLength(2);
  });

  it("renders the compare line dashed", () => {
    const { container } = render(
      <TimeChart
        label="x"
        kind="line"
        buckets={buckets(3)}
        series={[series("a", [3, 4, 2])]}
        compare={{ label: "Previous", values: [2, 2, 3] }}
      />,
    );
    const path = container.querySelector('[data-mark="compare"] path');
    expect(path!.getAttribute("stroke-dasharray")).toBe("4 4");
  });
});

describe("TimeChart hover and keyboard", () => {
  it("shows every series and the compare value for the hovered bucket", () => {
    const { container } = render(
      <TimeChart
        label="x"
        kind="stack"
        unit="usd"
        buckets={buckets(4)}
        series={[series("a", [3, 10, 1, 1]), series("b", [2, 20, 1, 1])]}
        compare={{ label: "Previous", values: [1, 25, 1, 1] }}
      />,
    );
    expect(tooltip(container)).toBeNull();
    fireEvent.pointerMove(hit(container), { clientX: BAND + 10 });
    const tip = tooltip(container)!;
    expect(tip.textContent).toContain("Day 1");
    expect(tip.textContent).toContain("$30.00Total");
    expect(tip.textContent).toContain("$10.00A");
    expect(tip.textContent).toContain("$20.00B");
    expect(tip.textContent).toContain("$25.00Previous");
    fireEvent.pointerLeave(hit(container));
    expect(tooltip(container)).toBeNull();
  });

  it("dims the other bars while one is hovered", () => {
    const { container } = render(
      <TimeChart
        label="x"
        kind="stack"
        buckets={buckets(4)}
        series={[series("a", [1, 2, 3, 4])]}
      />,
    );
    fireEvent.pointerMove(hit(container), { clientX: 2 * BAND + 1 });
    const opacity = [...bars(container)].map((b) => b.getAttribute("opacity"));
    expect(opacity).toEqual(["0.55", "0.55", "1", "0.55"]);
  });

  it("marks a gap as no value in the tooltip, never 0", () => {
    const { container } = render(
      <TimeChart
        label="x"
        kind="line"
        buckets={buckets(4)}
        series={[series("a", [1, null, 3, 4])]}
      />,
    );
    fireEvent.pointerMove(hit(container), { clientX: BAND + 1 });
    expect(tooltip(container)!.textContent).toContain("—A");
  });

  it("steps with the arrow keys from the newest bucket and picks on Enter", () => {
    const onPick = vi.fn();
    const { container } = render(
      <TimeChart
        label="Tasks per day"
        kind="line"
        buckets={buckets(4)}
        series={[series("a", [1, 2, 3, 4])]}
        onPick={onPick}
      />,
    );
    const svg = screen.getByRole("img", { name: "Tasks per day" });
    fireEvent.focusIn(svg);
    expect(tooltip(container)!.textContent).toContain("Day 3");
    fireEvent.keyDown(svg, { key: "ArrowLeft" });
    fireEvent.keyDown(svg, { key: "ArrowLeft" });
    expect(tooltip(container)!.textContent).toContain("Day 1");
    fireEvent.keyDown(svg, { key: "Enter" });
    expect(onPick).toHaveBeenCalledWith(1);
    fireEvent.keyDown(svg, { key: "Home" });
    expect(tooltip(container)!.textContent).toContain("Day 0");
    fireEvent.focusOut(svg);
    expect(tooltip(container)).toBeNull();
  });

  it("picks the clicked bucket", () => {
    const onPick = vi.fn();
    const { container } = render(
      <TimeChart
        label="x"
        kind="stack"
        buckets={buckets(4)}
        series={[series("a", [1, 2, 3, 4])]}
        onPick={onPick}
      />,
    );
    fireEvent.pointerMove(hit(container), { clientX: 3 * BAND + 1 });
    fireEvent.click(hit(container));
    expect(onPick).toHaveBeenCalledWith(3);
  });
});

describe("TimeChart legend and edge cases", () => {
  it("shows a legend only for two or more series or a compare line", () => {
    const one = render(
      <TimeChart
        label="x"
        kind="line"
        buckets={buckets(2)}
        series={[series("a", [1, 2])]}
      />,
    );
    expect(one.queryByRole("list", { name: "Legend" })).toBeNull();
    one.unmount();
    const two = render(
      <TimeChart
        label="x"
        kind="line"
        buckets={buckets(2)}
        series={[series("a", [1, 2])]}
        compare={{ label: "Previous", values: [1, 1] }}
      />,
    );
    expect(two.getByRole("list", { name: "Legend" }).textContent).toBe(
      "Previous",
    );
  });

  it("renders the empty state for no buckets", () => {
    const { container } = render(
      <TimeChart
        label="x"
        kind="line"
        buckets={[]}
        series={[series("a", [])]}
      />,
    );
    expect(
      container.querySelector('[data-chart-state="empty"]'),
    ).not.toBeNull();
    expect(container.querySelector("svg")).toBeNull();
  });

  it("draws a single bucket", () => {
    const { container } = render(
      <TimeChart
        label="x"
        kind="stack"
        buckets={buckets(1)}
        series={[series("a", [5])]}
      />,
    );
    expect(bars(container)).toHaveLength(1);
  });

  it("draws an all-zero chart with an axis and no bars", () => {
    const { container } = render(
      <TimeChart
        label="x"
        kind="stack"
        buckets={buckets(3)}
        series={[series("a", [0, 0, 0])]}
      />,
    );
    expect(bars(container)).toHaveLength(0);
    expect(container.querySelectorAll("line").length).toBeGreaterThan(1);
  });

  it("folds series past ten into Other", () => {
    const many = Array.from({ length: 12 }, (_, i) => series(`s${i}`, [1]));
    const { container } = render(
      <TimeChart label="x" kind="stack" buckets={buckets(1)} series={many} />,
    );
    expect(bars(container)).toHaveLength(10);
    expect(screen.getByRole("list", { name: "Legend" }).textContent).toContain(
      "Other (3)",
    );
  });

  it("throws on a series of the wrong length", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() =>
      render(
        <TimeChart
          label="x"
          kind="line"
          buckets={buckets(3)}
          series={[series("a", [1])]}
        />,
      ),
    ).toThrow(/1 values for 3 buckets/);
    vi.restoreAllMocks();
  });
});

describe("ChartOrTable", () => {
  it("renders the table twin newest first, with the partial bucket marked", () => {
    const onPick = vi.fn();
    render(
      <ChartOrTable
        asTable
        label="x"
        kind="stack"
        unit="count"
        buckets={buckets(3, true)}
        series={[series("a", [1, 2, 3]), series("b", [4, null, 6])]}
        compare={{ label: "Previous", values: [7, 8, 9] }}
        onPick={onPick}
      />,
    );
    const text = document.body.textContent;
    expect(text.indexOf("Day 2 (so far)")).toBeLessThan(text.indexOf("Day 1"));
    expect(text.indexOf("Day 1")).toBeLessThan(text.indexOf("Day 0"));
    expect(text).toContain("Total");
    expect(text).toContain("Previous");
    expect(text).toContain("—");
    fireEvent.click(screen.getByText("Day 1"));
    expect(onPick).toHaveBeenCalledWith(1);
  });
});
