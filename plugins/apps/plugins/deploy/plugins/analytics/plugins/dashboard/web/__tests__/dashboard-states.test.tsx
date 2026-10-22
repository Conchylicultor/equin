/**
 * The dashboard's body for every answer: a loading state while the report is
 * asked for, and an explicit, named error for every failure — never KPI tiles
 * or panels over an unknown or failed read.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@plugins/primitives/plugins/log-channels/web", () => ({
  clientLog: () => {},
}));

const answer = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));

vi.mock("@plugins/network/plugins/live/web", () => ({
  useLive: () => answer.current,
}));
// Recharts measures a real layout jsdom does not have; the chart is not what
// these states are about.
vi.mock("../components/trend-chart", () => ({
  TrendChart: () => <div data-testid="trend-chart" />,
}));

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ResourceError } from "@plugins/primitives/plugins/live-state/core";
import type { AnalyticsReport } from "@plugins/apps/plugins/deploy/plugins/analytics/plugins/collect/core";
import type { DeploymentAnalyticsResult } from "../../core";
import { AnalyticsDashboard } from "../components/analytics-dashboard";
import { report, row } from "../testing";

afterEach(cleanup);

const refetch = vi.fn(() => Promise.resolve());
const refresh = vi.fn(() => Promise.resolve());

function settled(data: DeploymentAnalyticsResult) {
  answer.current = { status: "ready", data, refetch, refresh };
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
    answer.current = { status: "loading", refetch, refresh };
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
      refresh,
    };
    renderDashboard();
    expectNoDashboard();
    expect(screen.getByText(/This deployment no longer exists\./)).toBeTruthy();
  });

  it.each<[string, DeploymentAnalyticsResult, RegExp]>([
    ["no key", { kind: "no-ssh-key" }, /has no SSH key yet/],
    ["unverified", { kind: "unverified" }, /never verified/],
    [
      "ssh failure",
      {
        kind: "ssh-failed",
        failure: "auth",
        message: "auth failed",
        stderr: "Permission denied (publickey).",
      },
      /rejected this app's SSH key/,
    ],
    [
      "site down",
      { kind: "request-failed", exitCode: 7, stderr: "" },
      /not running/,
    ],
    [
      "site error",
      { kind: "request-failed", exitCode: 22, stderr: "404" },
      /deploy it again/,
    ],
    [
      "unreadable",
      { kind: "unreadable-answer", detail: "Not JSON" },
      /not with an analytics report/,
    ],
    [
      "refused",
      {
        kind: "refused",
        reason: "stacked-filters-beyond-raw-window",
        maxFilters: 1,
        rawWindowDays: 90,
      },
      /last 90 days/,
    ],
  ])("renders %s as an explicit error state", (_name, data, text) => {
    settled(data);
    renderDashboard();
    expectNoDashboard();
    expect(screen.getByRole("alert").textContent).toMatch(text);
  });

  it("shows the SSH diagnostic verbatim", () => {
    settled({
      kind: "ssh-failed",
      failure: "unknown",
      message: "?",
      stderr: "kex_exchange_identification: boom",
    });
    renderDashboard();
    expect(screen.getByText("kex_exchange_identification: boom")).toBeTruthy();
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

  it("re-measures only when asked", () => {
    settled({ kind: "report", report: report() });
    refresh.mockClear();
    renderDashboard();
    expect(refresh).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
