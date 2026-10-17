/**
 * The merged run surface over the `runs` union window (step 12c of
 * research/2026-10-01-global-scoped-change-routing-p5-p8-v2.md):
 *
 * - `<RunDuration>` — a finished run reads its server `duration`; a running
 *   one (NULL duration) ticks its elapsed time off the browser clock, once a
 *   second, with the same formatter;
 * - the base field schema resolves against the live source exactly as the
 *   DataView resolves it at mount: every base field binds its union column,
 *   a field marked sortable sorts in SQL, every filterable one filters in its
 *   column's domain — so the surface cannot throw on its own schema;
 * - `<RunsDataView>`'s own wiring, mounted over a stubbed DataView (how rows
 *   draw is the primitive's tested behaviour): the host's empty line reaches
 *   it, a selected `{ kind, id }` highlights its row key, and the host's
 *   `onRowActivate` goes through untouched — where a row GOES is its arm's
 *   (`runLinks`, data-view's per-arm `CollectionRowActivation`, tested there);
 * - the `kind` source field's options are the registered arms, in their order.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import {
  liveDataSource,
  type FilterOperatorSet,
} from "@plugins/primitives/plugins/data-view/web";
import {
  deriveFields,
  resolveLiveFields,
} from "@plugins/primitives/plugins/data-view/web/testing";
import { liveArm } from "@plugins/network/plugins/live/core";
import { runRowKey, runs, type RunRow } from "../../core";
import { RunDuration } from "../components/run-duration";
import { RunsDataView } from "../components/runs-data-view";

/** What the stubbed seams hold for the `<RunsDataView>` suite. */
const stub = vi.hoisted(() => ({
  /** The props the stubbed DataView last rendered with. */
  props: undefined as Record<string, unknown> | undefined,
}));

vi.mock(
  "@plugins/primitives/plugins/data-view/web",
  async (importOriginal) => ({
    ...(await importOriginal<object>()),
    DataView: (props: Record<string, unknown>) => {
      stub.props = props;
      return null;
    },
  }),
);

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const NOW = new Date("2026-10-02T12:00:00Z");

/** Two arms as their cores declare them — a kind and its label, no fields of their own. */
const buildArm = liveArm(runs, "build", {
  label: "Build",
  order: 10,
  fields: {},
});
const releaseArm = liveArm(runs, "release", {
  label: "Release",
  order: 20,
  fields: {},
});

describe("<RunDuration>", () => {
  it("a finished run reads its duration", () => {
    render(
      <RunDuration
        run={{
          startedAt: new Date(NOW.getTime() - 100_000),
          finishedAt: NOW,
          duration: 100_000,
        }}
      />,
    );
    expect(screen.getByText("1m 40s")).not.toBeNull();
  });

  it("a running run ticks its elapsed time once a second", () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    vi.setSystemTime(NOW);
    render(
      <RunDuration
        run={{
          startedAt: new Date(NOW.getTime() - 90_000),
          finishedAt: null,
          duration: null,
        }}
      />,
    );
    expect(screen.getByText("1m 30s")).not.toBeNull();
    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    expect(screen.getByText("1m 32s")).not.toBeNull();
  });
});

/** Operator sets reduced to what field resolution reads: each type's domain. */
const DOMAINS: Record<string, FilterOperatorSet["domain"]> = {
  text: "text",
  enum: "text",
  number: "number",
  float: "number",
  date: "instant",
};
const resolveOperatorSet = (type: string): FilterOperatorSet | undefined =>
  DOMAINS[type] === undefined
    ? undefined
    : { match: type, domain: DOMAINS[type]!, operators: [] };

describe("the base field schema over the runs source", () => {
  it("resolves at mount: every derived field binds a union column, sorts and filters as declared", () => {
    const source = liveDataSource(runs, {
      searchable: ["label", "message", "namespace", "trigger"],
    });
    const { fields } = deriveFields(runs, true, []);
    // The persisted vocabulary: saved views and presets name these ids.
    expect(fields.map((f) => f.id)).toEqual([
      "label",
      "kind",
      "outcome",
      "trigger",
      "namespace",
      "duration",
      "startedAt",
      "finishedAt",
      "message",
    ]);
    const plan = resolveLiveFields<RunRow>(
      fields as never,
      source,
      resolveOperatorSet,
      "runs",
    );
    expect([...plan.columnOf.keys()].sort()).toEqual(
      [
        "duration",
        "finishedAt",
        "kind",
        "label",
        "message",
        "namespace",
        "outcome",
        "startedAt",
        "trigger",
      ].sort(),
    );
    expect(plan.sortFields.map((f) => f.id)).toContain("duration");
    expect(plan.filterFields.map((f) => f.id)).toContain("kind");
    expect(fields.find((f) => f.id === "outcome")?.options?.[0]).toEqual({
      value: "running",
      label: "Running",
      variant: "warning",
    });
  });

  it("the kind source field offers the registered arms, in their order — not the loaded page's kinds", () => {
    // Registered release first (plugin load order); the options follow `order`.
    const { fields } = deriveFields(runs, true, [
      { owner: releaseArm, reads: [], fields: {} },
      { owner: buildArm, reads: [], fields: {} },
    ]);
    expect(fields.find((f) => f.id === "kind")?.options).toEqual([
      { value: "build", label: "Build" },
      { value: "release", label: "Release" },
    ]);
  });
});

describe("<RunsDataView>", () => {
  beforeEach(() => {
    stub.props = undefined;
  });

  it("hands the DataView the host's empty line and the live runs source", () => {
    render(<RunsDataView emptyState="No backups yet." />);
    expect(stub.props!.emptyState).toBe("No backups yet.");
    expect(stub.props!.selectedRowId).toBeUndefined();
  });

  it("highlights the selected run by its row key — the (kind, id) pair, not a bare id", () => {
    render(
      <RunsDataView
        emptyState="none"
        selectedRun={{ kind: "build", id: "b:1" }}
      />,
    );
    expect(stub.props!.selectedRowId).toBe(
      runRowKey({ kind: "build", id: "b:1" }),
    );
    expect(stub.props!.selectedRowId).toBe("build:b:1");
  });

  it("hands the host's onRowActivate straight through — where a row goes is its arm's", () => {
    const onRowActivate = vi.fn();
    render(<RunsDataView emptyState="none" onRowActivate={onRowActivate} />);
    expect(stub.props!.onRowActivate).toBe(onRowActivate);
    expect(stub.props!.rowActivation).toBeUndefined();
  });
});
