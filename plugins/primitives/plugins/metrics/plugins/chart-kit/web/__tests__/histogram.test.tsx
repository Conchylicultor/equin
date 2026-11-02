import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock(
  "@plugins/primitives/plugins/dom/plugins/element-size/web",
  async (importOriginal) => ({
    ...(await importOriginal<object>()),
    useElementSize: () => [() => {}, { width: 446, height: 210 }],
  }),
);

import { cleanup, fireEvent, render } from "@testing-library/react";
import { Histogram, type HistogramBin } from "../components/histogram";

afterEach(cleanup);

const bins: HistogramBin[] = [
  { label: "a", range: "Under $1", count: 12 },
  {
    label: "b",
    range: "$1 – $5",
    count: 40,
    extra: [{ label: "spent", value: "$120" }],
  },
  { label: "c", range: "$5 – $10", count: 7 },
  { label: "d", range: "$10+", count: 0 },
];

// width 446 − margins (40 + 6) = 400px of plot; 4 bins → 100px each.
const BAND = 100;

describe("Histogram", () => {
  it("draws one bar per non-empty bin", () => {
    const { container } = render(
      <Histogram label="x" bins={bins} countLabel="conversations" />,
    );
    expect(container.querySelectorAll('[data-mark="bar"]')).toHaveLength(3);
  });

  it("shows the bin's count and extra rows on hover", () => {
    const { container } = render(
      <Histogram label="x" bins={bins} countLabel="conversations" />,
    );
    fireEvent.pointerMove(container.querySelector("[data-hit]")!, {
      clientX: BAND + 5,
    });
    const tip = container.querySelector("[data-chart-tooltip]")!.textContent;
    expect(tip).toContain("$1 – $5");
    expect(tip).toContain("40conversations");
    expect(tip).toContain("$120spent");
  });

  it("renders the empty state for no bins", () => {
    const { container } = render(
      <Histogram label="x" bins={[]} countLabel="c" />,
    );
    expect(
      container.querySelector('[data-chart-state="empty"]'),
    ).not.toBeNull();
  });
});
