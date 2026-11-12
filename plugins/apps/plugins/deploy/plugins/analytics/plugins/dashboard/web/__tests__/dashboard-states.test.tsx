/**
 * The dashboard's body for every answer: a loading state while the report is
 * asked for or the site's tables are not copied yet, and an explicit, named
 * state for a refusal or a failed read — never KPI tiles or panels over an
 * unknown or failed read.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock(
  "@plugins/primitives/plugins/log-channels/web",
  async (importOriginal) => ({
    ...(await importOriginal<object>()),
    clientLog: () => {},
  }),
);

const answer = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));

vi.mock("@plugins/network/plugins/live/web", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useLive: () => answer.current,
}));
// The freshness line above the report is site-mirror's (and its tests');
// here it only has to be there.
vi.mock(
  "@plugins/apps/plugins/deploy/plugins/site-mirror/plugins/pull/web",
  async (importOriginal) => ({
    ...(await importOriginal<object>()),
    MirrorFreshness: () => <div data-testid="mirror-freshness" />,
  }),
);
// Recharts measures a real layout jsdom does not have; the chart is not what
// these states are about.
vi.mock("../components/trend-chart", () => ({
  TrendChart: () => <div data-testid="trend-chart" />,
}));

import { cleanup, render, screen } from "@testing-library/react";
import { ResourceError } from "@plugins/network/plugins/live/plugins/live-state/core";
import type { AnalyticsReport } from "@plugins/apps/plugins/deploy/plugins/analytics/plugins/collect/core";
import type { DeploymentAnalyticsResult } from "../../core";
import { AnalyticsDashboard } from "../components/analytics-dashboard";
import { report, row } from "../testing";

afterEach(cleanup);

const refetch = vi.fn(() => Promise.resolve());

function settled(data: DeploymentAnalyticsResult) {
  answer.current = { status: "ready", data, refetch };
}

function renderDashboard() {
  return render(<AnalyticsDashboard deploymentId="dep-1" />);
}

function expectNoDashboard() {
  expect(screen.queryByRole("radiogroup", { name: "Chart metric" })).toBeNull();
  expect(screen.queryByTestId("trend-chart")).toBeNull();
}

describe("AnalyticsDashboard states", () => {
  it("shows a loading state, not an empty dashboard, while pending", () => {
    answer.current = { status: "loading", refetch };
    renderDashboard();
    expectNoDashboard();
    expect(screen.queryByRole("alert")).toBeNull();
    // The controls and the recorded-field list do not depend on the answer.
    expect(screen.getByRole("radio", { name: "30 days" })).toBeTruthy();
    expect(screen.getByText("What one visit records")).toBeTruthy();
  });

  it("names a refused read (the deployment is gone)", () => {
    answer.current = {
      status: "error",
      error: new ResourceError(
        "refused",
        "This deployment no longer exists.",
        null,
        "missing",
      ),
      refetch,
    };
    renderDashboard();
    expectNoDashboard();
    expect(screen.getByText(/This deployment no longer exists\./)).toBeTruthy();
  });

  it("shows a loading state, not an empty dashboard, while the site's tables are not copied yet", () => {
    settled({ kind: "not-copied" });
    renderDashboard();
    expectNoDashboard();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("What one visit records")).toBeTruthy();
    expect(screen.getByTestId("mirror-freshness")).toBeTruthy();
  });

  it.each<[string, DeploymentAnalyticsResult, RegExp]>([
    [
      "stacked filters",
      {
        kind: "refused",
        reason: "stacked-filters-beyond-raw-window",
        maxFilters: 1,
        rawWindowDays: 90,
      },
      /last 90 days/,
    ],
    [
      "an audience past the raw window",
      {
        kind: "refused",
        reason: "audience-beyond-raw-window",
        rawWindowDays: 90,
      },
      /only visitors are kept/,
    ],
  ])("renders a refusal (%s) as an explicit state", (_name, data, text) => {
    settled(data);
    renderDashboard();
    expectNoDashboard();
    expect(screen.getByRole("alert").textContent).toMatch(text);
  });

  it("renders a report as tiles, chart and panels", () => {
    settled({ kind: "report", report: report() });
    renderDashboard();
    expect(
      screen.getByRole("radiogroup", { name: "Chart metric" }),
    ).toBeTruthy();
    expect(screen.getByTestId("trend-chart")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Search/ })).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows the Countries tab's rows and data credit, not a 'not collected yet' state", () => {
    settled({
      kind: "report",
      report: report({
        rows: {
          country: [row("FR", { visitors: 5 })],
        } as Partial<AnalyticsReport["rows"]> as AnalyticsReport["rows"],
      }),
    });
    renderDashboard();
    expect(
      screen.getByRole("button", {
        name: (name) => name.startsWith("France (FR)"),
      }),
    ).toBeTruthy();
    expect(screen.getByRole("link", { name: "DB-IP" })).toBeTruthy();
    expect(screen.queryByText("Not collected yet.")).toBeNull();
  });
});
