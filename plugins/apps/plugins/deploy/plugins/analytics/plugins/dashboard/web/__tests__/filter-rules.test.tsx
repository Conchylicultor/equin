/**
 * The filter-chip rules: what clicking a ranked row does (add, replace, remove,
 * or refuse on a daily-totals report that already holds its one filter), as the
 * pure rule and as the panel and chip bar render it.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  MAX_FILTERS,
  NONE_VALUE,
  VISIT_DIMENSIONS,
  type AnalyticsFilter,
  type AnalyticsReport,
} from "@plugins/apps/plugins/deploy/plugins/analytics/plugins/collect/core";
import { IP_COUNTRY_SOURCE } from "@plugins/apps/plugins/deploy/plugins/analytics/plugins/ip-country/core";
import {
  FILTERS_TOO_LONG_NOTE,
  MAX_FILTERS_NOTE,
  STACKED_FILTERS_NOTE,
  clickRow,
} from "../internal/filters";
import { PANELS } from "../internal/panels";
import { RankedPanel } from "../components/ranked-panel";
import { FilterBar } from "../components/filter-bar";
import { report, row } from "../testing";

/** jsdom's navigator.language is en-US. */
const FRANCE = "France (FR)";

/** A row's accessible name is its label followed by its numbers. */
const startsWith = (label: string) => (name: string) => name.startsWith(label);

afterEach(cleanup);

const SEARCH: AnalyticsFilter = { dimension: "channel", value: "Search" };
const HOME: AnalyticsFilter = { dimension: "page", value: "/" };

describe("clickRow", () => {
  it("adds a filter on a new dimension", () => {
    expect(clickRow([], "raw", "channel", "Search")).toEqual({
      kind: "add",
      next: [SEARCH],
    });
  });

  it("removes the row's own filter", () => {
    expect(clickRow([SEARCH, HOME], "raw", "channel", "Search")).toEqual({
      kind: "remove",
      next: [HOME],
    });
  });

  it("replaces another value of the same dimension", () => {
    expect(clickRow([SEARCH], "raw", "channel", "Direct")).toEqual({
      kind: "replace",
      next: [{ dimension: "channel", value: "Direct" }],
    });
  });

  it("stacks filters on a raw report, up to the query's cap", () => {
    expect(clickRow([SEARCH], "raw", "page", "/").kind).toBe("add");
    const full = VISIT_DIMENSIONS.slice(0, MAX_FILTERS).map((dimension) => ({
      dimension,
      value: "x",
    }));
    expect(clickRow(full, "raw", "page", "/")).toEqual({
      kind: "blocked",
      reason: MAX_FILTERS_NOTE,
    });
  });

  it("refuses an add or a replace whose filters would not fit one question", () => {
    const long = "/" + "a".repeat(600);
    const two = [
      { dimension: "page" as const, value: long },
      { dimension: "entry_page" as const, value: long },
    ];
    expect(clickRow(two, "raw", "exit_page", long)).toEqual({
      kind: "blocked",
      reason: FILTERS_TOO_LONG_NOTE,
    });
    expect(
      clickRow([two[0]!, SEARCH], "raw", "channel", "b".repeat(1000)),
    ).toEqual({ kind: "blocked", reason: FILTERS_TOO_LONG_NOTE });
    // Removing still works, and a short value still fits.
    expect(clickRow(two, "raw", "page", long).kind).toBe("remove");
    expect(clickRow(two, "raw", "exit_page", "/").kind).toBe("add");
  });

  it("refuses a second filter on a totals report, but still replaces and removes", () => {
    expect(clickRow([SEARCH], "totals", "page", "/")).toEqual({
      kind: "blocked",
      reason: STACKED_FILTERS_NOTE,
    });
    expect(clickRow([SEARCH], "totals", "channel", "Direct").kind).toBe(
      "replace",
    );
    expect(clickRow([SEARCH], "totals", "channel", "Search").kind).toBe(
      "remove",
    );
    expect(clickRow([], "totals", "page", "/").kind).toBe("add");
  });
});

function renderPanel(
  id: string,
  filters: AnalyticsFilter[],
  source: "raw" | "totals",
) {
  const onFilterRow = vi.fn();
  const panel = PANELS.find((p) => p.id === id)!;
  render(
    <RankedPanel
      panel={panel}
      tabId={panel.tabs[0]!.id}
      onTab={() => {}}
      report={report()}
      source={source}
      filters={filters}
      onFilterRow={onFilterRow}
    />,
  );
  return onFilterRow;
}

describe("RankedPanel", () => {
  it("reports a row click with its dimension and value", () => {
    const onFilterRow = renderPanel("pages", [], "raw");
    fireEvent.click(screen.getByRole("button", { name: /\/story/ }));
    expect(onFilterRow).toHaveBeenCalledWith("page", "/story");
  });

  it("marks the filtered row selected", () => {
    renderPanel("sources", [SEARCH], "raw");
    const search = screen.getByRole("button", { name: /Search/ });
    expect(search.getAttribute("aria-current")).toBe("true");
  });

  it("disables rows that would stack a second filter on a totals report", () => {
    renderPanel("pages", [SEARCH], "totals");
    const home = screen.getAllByRole("button", { name: /^\// })[0]!;
    expect((home as HTMLButtonElement).disabled).toBe(true);
    expect(home.getAttribute("title")).toBe(STACKED_FILTERS_NOTE);
  });

  it("keeps rows of the filtered dimension clickable on a totals report", () => {
    renderPanel("sources", [SEARCH], "totals");
    const direct = screen.getByRole("button", { name: /Direct/ });
    expect((direct as HTMLButtonElement).disabled).toBe(false);
  });

  it("names a country next to its code, and filters on the code", () => {
    const onFilterRow = vi.fn();
    const panel = PANELS.find((p) => p.id === "locations")!;
    render(
      <RankedPanel
        panel={panel}
        tabId="countries"
        onTab={() => {}}
        report={report({
          rows: {
            country: [
              row("FR", { visitors: 5 }),
              row("XX", { visitors: 2 }),
              row(NONE_VALUE, { visitors: 1 }),
            ],
          } as Partial<AnalyticsReport["rows"]> as AnalyticsReport["rows"],
        })}
        source="raw"
        filters={[]}
        onFilterRow={onFilterRow}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: startsWith(FRANCE) }));
    expect(onFilterRow).toHaveBeenCalledWith("country", "FR");
    // A code the platform cannot name, and the no-country value, read as stored.
    expect(screen.getByRole("button", { name: startsWith("XX") })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: startsWith(NONE_VALUE) }),
    ).toBeTruthy();
  });

  it("credits the IP geolocation source under the Countries tab, with a link", () => {
    renderPanel("locations", [], "raw");
    const note = screen.getByText(/Looked up from the visitor's IP/);
    expect(note.textContent).toBe(
      "Looked up from the visitor's IP, which is not stored. IP geolocation by DB-IP (db-ip.com), CC BY 4.0.",
    );
    const link = screen.getByRole("link", { name: IP_COUNTRY_SOURCE.name });
    expect(link.getAttribute("href")).toBe(IP_COUNTRY_SOURCE.url);
  });
});

describe("FilterBar", () => {
  it("renders nothing without filters", () => {
    const { container } = render(
      <FilterBar
        filters={[]}
        source="raw"
        onRemove={() => {}}
        onClear={() => {}}
      />,
    );
    expect(container.textContent).toBe("");
  });

  it("renders a removable chip per filter and a Clear button", () => {
    const onRemove = vi.fn();
    const onClear = vi.fn();
    render(
      <FilterBar
        filters={[SEARCH, HOME]}
        source="raw"
        onRemove={onRemove}
        onClear={onClear}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Remove filter Page is /" }),
    );
    expect(onRemove).toHaveBeenCalledWith("page");
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(onClear).toHaveBeenCalled();
    expect(screen.queryByText(STACKED_FILTERS_NOTE)).toBeNull();
  });

  it("explains, in one line, why a totals report takes no second filter", () => {
    render(
      <FilterBar
        filters={[SEARCH]}
        source="totals"
        onRemove={() => {}}
        onClear={() => {}}
      />,
    );
    expect(screen.getByText(STACKED_FILTERS_NOTE)).toBeTruthy();
  });

  it("names a country filter the way its row does", () => {
    render(
      <FilterBar
        filters={[{ dimension: "country", value: "FR" }]}
        source="raw"
        onRemove={() => {}}
        onClear={() => {}}
      />,
    );
    expect(
      screen.getByRole("button", {
        name: `Remove filter Country is ${FRANCE}`,
      }),
    ).toBeTruthy();
  });
});
