/**
 * The Events panel's breakdown: an event with props gets an expander that
 * unfolds its `event_prop` rows, one group per key; a breakdown row filters by
 * its own (event_prop, value). An event without props has no expander.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { Dimension } from "@plugins/apps/plugins/deploy/plugins/analytics/plugins/collect/core";
import { PANELS } from "../internal/panels";
import { RankedPanel } from "../components/ranked-panel";
import { report, row } from "../testing";

afterEach(cleanup);

const events = PANELS.find((p) => p.id === "events")!;
const sample = report({
  rows: {
    ...report().rows,
    event: [
      row("card_open", { visitors: 4, events: 10 }),
      row("improve_open", { visitors: 2, events: 2 }),
    ],
    event_prop: [
      row("card_open.card=Pages", { visitors: 3, events: 6 }),
      row("card_open.card=Mail", { visitors: 2, events: 4 }),
      row("card_open.layer=The apps", { visitors: 4, events: 10 }),
    ],
  },
});

function renderPanel(onFilterRow: (d: Dimension, v: string) => void) {
  render(
    <RankedPanel
      panel={events}
      tabId="events"
      onTab={() => {}}
      report={sample}
      source="raw"
      filters={[]}
      onFilterRow={onFilterRow}
    />,
  );
}

describe("event breakdown", () => {
  it("expands an event with props into its groups, and filters by a prop", () => {
    const onFilterRow = vi.fn();
    renderPanel(onFilterRow);
    expect(screen.queryByText("Pages")).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Expand improve_open" }),
    ).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Expand card_open" }));
    expect(screen.getByText("by card")).toBeTruthy();
    expect(screen.getByText("by layer")).toBeTruthy();
    // 10 events over 4 visitors
    expect(screen.getAllByText("2.5").length).toBeGreaterThan(0);

    fireEvent.click(screen.getByTitle("Filter by Pages"));
    expect(onFilterRow).toHaveBeenCalledWith(
      "event_prop",
      "card_open.card=Pages",
    );
  });
});
