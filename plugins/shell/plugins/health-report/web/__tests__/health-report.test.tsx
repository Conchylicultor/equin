/**
 * The health report's host contract, driven through real slot contributions:
 * the dot's tone / count / pulse, a row that is not known yet keeping the dot
 * grey, a crashing check greying (never greening) the dot while its siblings
 * keep reporting, the detail mounted only once expanded, and info rows never
 * moving the count.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useSyncExternalStore } from "react";
import {
  PluginProvider,
  type LoadedPlugin,
} from "@plugins/framework/plugins/web-sdk/core";
import {
  boundaryReportSink,
  type BoundaryErrorReport,
} from "@plugins/primitives/plugins/error-boundary/web";
import type {
  HealthReportRow,
  HealthStatus,
  SetItemProps,
  SetRow,
  SetRows,
  StatusRow,
} from "../../core";
import { HealthReport } from "../slots";
import { HealthReportButton } from "../components/health-report-button";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { SlotRender } from "@plugins/primitives/plugins/slot-render/web";
import type { Activity } from "@plugins/primitives/plugins/css/plugins/activity-ring/web";

const accountTreeIcon = symbol("account-tree");

const consoleError = console.error;
afterEach(() => {
  cleanup();
  boundaryReportSink.register(null);
  console.error = consoleError;
});

function renderReport(
  rows: HealthReportRow[],
  activities?: Activity[],
  extraPlugins: LoadedPlugin[] = [],
) {
  const plugin = {
    id: "shell.health-report",
    description: "health report fixture",
    // A rendered slot must be a DECLARED slot — its id derives from the
    // declaring plugin, exactly as in the app.
    slots: HealthReport,
    contributions: rows.map((row) => HealthReport.Row(row)),
  } as unknown as LoadedPlugin;
  return render(
    <PluginProvider plugins={[plugin, ...extraPlugins]}>
      <HealthReportButton activities={activities} />
    </PluginProvider>,
  );
}

const status = (
  id: string,
  value: HealthStatus,
  extra: Partial<StatusRow> = {},
): StatusRow => ({
  kind: "status",
  id,
  title: id,
  useStatus: () => value,
  ...extra,
});

const info = (id: string, useInfo = () => ({ title: id, summary: "where" })) =>
  ({
    kind: "info",
    id,
    icon: accountTreeIcon,
    useInfo,
  }) satisfies HealthReportRow;

function button(): HTMLElement {
  const el = document.querySelector<HTMLElement>("[data-health]");
  if (!el) throw new Error("health button not rendered");
  return el;
}

/** The dot is the only element inside the button carrying a `bg-*` fill. */
function dotClass(): string {
  const dot = button().querySelector("span[class*='bg-']");
  if (!dot) throw new Error("health dot not rendered");
  return dot.className;
}

/**
 * A row's summary line. The header repeats the one non-green row's summary as
 * its verdict, so a bare text query would match twice.
 */
function summary(text: string): HTMLElement {
  return screen.getByText(text, { selector: ".text-caption" });
}

async function openReport(): Promise<void> {
  fireEvent.click(button());
  await screen.findByRole("dialog");
}

describe("the health dot", () => {
  it("is a green dot only, with no count, when every row is ok", () => {
    renderReport([
      status("a", { state: "ok", summary: "fine" }),
      status("b", { state: "ok", summary: "fine" }),
    ]);
    expect(button().dataset.health).toBe("ok");
    expect(button().getAttribute("aria-label")).toBe("All systems normal");
    expect(button().textContent).toBe("");
    expect(dotClass()).toContain("bg-success");
    expect(dotClass()).not.toContain("animate-pulse");
  });

  it("is ok over zero rows", () => {
    renderReport([]);
    expect(button().dataset.health).toBe("ok");
    expect(button().getAttribute("aria-label")).toBe("All systems normal");
  });

  it("takes the worst tone and counts the rows that need a look", () => {
    renderReport([
      status("a", { state: "ok", summary: "fine" }),
      status("b", { state: "attention", summary: "look" }),
      status("c", { state: "critical", summary: "broken" }),
    ]);
    expect(button().dataset.health).toBe("critical");
    expect(button().textContent).toBe("2");
    expect(button().getAttribute("aria-label")).toBe("2 things need attention");
    expect(dotClass()).toContain("bg-destructive");
  });

  it("names the one row that needs a look", () => {
    renderReport([
      status("a", { state: "ok", summary: "fine" }),
      status("b", { state: "attention", summary: "Reconnecting to server…" }),
    ]);
    expect(button().dataset.health).toBe("attention");
    expect(button().textContent).toBe("1");
    expect(button().getAttribute("aria-label")).toBe("Reconnecting to server…");
    expect(dotClass()).toContain("bg-warning");
  });

  it("pulses while a row is transitioning", () => {
    renderReport([
      status("a", {
        state: "attention",
        summary: "Reconnecting…",
        transitioning: true,
      }),
    ]);
    expect(dotClass()).toContain("animate-pulse");
  });

  it("stays grey and pulsing until every row has reported, then turns green", () => {
    let current: HealthStatus = { state: "unknown" };
    const listeners = new Set<() => void>();
    const useLate = () =>
      useSyncExternalStore(
        (l) => {
          listeners.add(l);
          return () => listeners.delete(l);
        },
        () => current,
        () => current,
      );
    renderReport([
      status("ready", { state: "ok", summary: "fine" }),
      { ...status("late", { state: "ok", summary: "" }), useStatus: useLate },
    ]);
    expect(button().dataset.health).toBe("unknown");
    expect(button().getAttribute("aria-label")).toBe("Checking…");
    expect(dotClass()).toContain("bg-muted-foreground");
    expect(dotClass()).toContain("animate-pulse");

    act(() => {
      current = { state: "ok", summary: "fine" };
      for (const l of listeners) l();
    });
    expect(button().dataset.health).toBe("ok");
    expect(dotClass()).not.toContain("animate-pulse");
  });

  it("greys the dot when a check throws, files the crash, and keeps its siblings", async () => {
    console.error = () => {};
    const reports: BoundaryErrorReport[] = [];
    boundaryReportSink.register((r) => {
      reports.push(r);
    });
    renderReport([
      status("healthy", { state: "ok", summary: "Server connected" }),
      {
        ...status("broken", { state: "ok", summary: "" }),
        useStatus: () => {
          throw new Error("check exploded");
        },
      },
    ]);
    expect(button().dataset.health).toBe("unknown");
    expect(button().getAttribute("aria-label")).toBe("This check crashed");
    // Crashed is KNOWN to be unreadable, not "still loading": grey, still.
    expect(dotClass()).not.toContain("animate-pulse");
    await waitFor(() => expect(reports).toHaveLength(1));
    expect(reports[0]?.error.message).toBe("check exploded");
    expect(reports[0]?.slot).toBe("shell.health-report.row");

    await openReport();
    expect(summary("Server connected")).toBeTruthy();
    expect(summary("This check crashed")).toBeTruthy();
  });
});

describe("activities", () => {
  const ok = status("a", { state: "ok", summary: "fine" });

  it("draw no ring when there are none", () => {
    renderReport([ok]);
    expect(button().querySelector("svg circle")).toBeNull();
  });

  it("ring the dot and join its name; running wins over failed", () => {
    renderReport(
      [ok],
      [
        { state: "failed", label: "Sync failed" },
        { state: "running", label: "Building" },
      ],
    );
    expect(button().getAttribute("aria-label")).toBe(
      "All systems normal · Sync failed · Building",
    );
    expect(button().querySelector("svg.animate-spin")).not.toBeNull();
    expect(dotClass()).toContain("bg-success");
  });

  it("a failed one alone breaks the ring, without spinning", () => {
    renderReport([ok], [{ state: "failed", label: "Build failed" }]);
    expect(
      button().querySelector("svg .stroke-destructive-solid"),
    ).not.toBeNull();
    expect(button().querySelector("svg.animate-spin")).toBeNull();
  });
});

describe("the report", () => {
  it("mounts a row's detail only after it is expanded", async () => {
    const detailMounts = vi.fn();
    function Detail() {
      detailMounts();
      return <div data-testid="detail">jobs holding a slot</div>;
    }
    renderReport([
      status(
        "queue",
        { state: "ok", summary: "3 running" },
        {
          title: "Job queue",
          glance: () => <div data-testid="glance">bars</div>,
          component: Detail,
        },
      ),
      status("connection", { state: "ok", summary: "connected" }),
    ]);
    await openReport();
    expect(screen.getByTestId("glance")).toBeTruthy();
    expect(screen.queryByTestId("detail")).toBeNull();
    expect(detailMounts).not.toHaveBeenCalled();

    const trigger = screen.getByRole("button", { name: /Job queue/ });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    // A row with no detail is not a click target at all.
    expect(screen.queryByRole("button", { name: /connection/ })).toBeNull();

    fireEvent.click(trigger);
    expect(screen.getByTestId("detail")).toBeTruthy();
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
  });

  it("orders info rows first, then status rows in place whatever their state", async () => {
    renderReport([
      status("calm", { state: "ok", summary: "calm-summary" }),
      status("bad", { state: "critical", summary: "bad-summary" }),
      info("where", () => ({ title: "Worktree", summary: "where-summary" })),
    ]);
    await openReport();
    const order = ["where-summary", "calm-summary", "bad-summary"].map(summary);
    for (let i = 1; i < order.length; i++) {
      expect(
        order[i - 1]!.compareDocumentPosition(order[i]!) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    }
  });

  it("never lets an info row change the dot or the count, and reads it only while open", async () => {
    const useInfo = vi.fn(() => ({ title: "Worktree", summary: "att-1" }));
    renderReport([
      info("worktree", useInfo),
      status("a", { state: "attention", summary: "look" }),
    ]);
    expect(button().dataset.health).toBe("attention");
    expect(button().textContent).toBe("1");
    expect(useInfo).not.toHaveBeenCalled();

    await openReport();
    expect(summary("att-1")).toBeTruthy();
    expect(useInfo).toHaveBeenCalled();
    expect(button().textContent).toBe("1");
  });

  it("keeps a not-applicable row out of the dot, and lists it hollow", async () => {
    renderReport([
      status("calm", { state: "ok", summary: "calm-summary" }),
      status("machine", { state: "not-applicable", summary: "na-summary" }),
    ]);
    expect(button().dataset.health).toBe("ok");
    expect(button().getAttribute("aria-label")).toBe("All systems normal");
    expect(dotClass()).toContain("bg-success");

    await openReport();
    const calm = summary("calm-summary");
    const na = summary("na-summary");
    expect(
      calm.compareDocumentPosition(na) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      screen.getByRole("dialog").querySelector(".bg-transparent"),
    ).toBeTruthy();
  });

  it("folds the plain rows that are fine into one card, listed when expanded", async () => {
    renderReport([
      status("Connection", { state: "ok", summary: "conn-summary" }),
      status("Database", { state: "ok", summary: "db-summary" }),
      status("Live reads", { state: "attention", summary: "reads-summary" }),
      status("Socket", { state: "ok", summary: "socket-summary" }),
    ]);
    await openReport();
    // The row that needs a look stays on its own, outside the card.
    expect(summary("reads-summary")).toBeTruthy();
    expect(summary("All 3 normal")).toBeTruthy();
    expect(screen.queryByText("conn-summary")).toBeNull();

    const card = screen.getByRole("button", {
      name: /System checks/,
    });
    fireEvent.click(card);
    expect(summary("conn-summary")).toBeTruthy();
    expect(summary("db-summary")).toBeTruthy();
    expect(summary("socket-summary")).toBeTruthy();
  });

  it("folds a fine row with a detail too, still expandable inside the card", async () => {
    function Detail() {
      return <div data-testid="detail">storage detail</div>;
    }
    renderReport([
      status("Connection", { state: "ok", summary: "conn-summary" }),
      status(
        "storage",
        { state: "ok", summary: "storage-summary" },
        { title: "Browser storage", component: Detail },
      ),
      status(
        "queue",
        { state: "ok", summary: "queue-summary" },
        { title: "Job queue", glance: () => <div>bars</div> },
      ),
    ]);
    await openReport();
    // A glance is drawn at rest, so its row stays out of the card.
    expect(summary("queue-summary")).toBeTruthy();
    expect(summary("All 2 normal")).toBeTruthy();
    expect(screen.queryByText("storage-summary")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /System checks/ }));
    fireEvent.click(screen.getByRole("button", { name: /Browser storage/ }));
    expect(screen.getByTestId("detail")).toBeTruthy();
  });

  it("is green with an info row alone", () => {
    renderReport([info("worktree")]);
    expect(button().dataset.health).toBe("ok");
    expect(button().textContent).toBe("");
  });

  it("is a loading state — no rows — while the row order is not known", async () => {
    // A layout engine whose order for every slot is still loading.
    const pendingOrder = {
      id: "health-report-test-pending-order",
      description: "a slot order that never settles",
      contributions: [
        SlotRender.Order({
          useOrder: () => ({
            status: "loading" as const,
            refetch: () => Promise.resolve(),
          }),
        }),
      ],
    } as unknown as LoadedPlugin;
    renderReport(
      [status("a", { state: "attention", summary: "look-summary" })],
      undefined,
      [pendingOrder],
    );
    await openReport();
    const dialog = screen.getByRole("dialog");
    expect(dialog.querySelector('[aria-busy="true"]')).not.toBeNull();
    // No row is drawn (the header's verdict, over the published statuses, is).
    expect(
      screen.queryByText("look-summary", { selector: ".text-caption" }),
    ).toBeNull();
  });
});

describe("row sets", () => {
  /** A set whose rows are driven from the test. */
  function liveSet(initial: SetRows, extra: Partial<SetRow> = {}) {
    let current = initial;
    const listeners = new Set<() => void>();
    const useRows = () =>
      useSyncExternalStore(
        (l) => {
          listeners.add(l);
          return () => listeners.delete(l);
        },
        () => current,
        () => current,
      );
    const row: SetRow = {
      kind: "set",
      id: "sites",
      title: "Sites",
      useRows,
      ...extra,
    };
    const set = (next: SetRows) =>
      act(() => {
        current = next;
        for (const l of listeners) l();
      });
    return { row, set };
  }

  const ok = (summary: string): HealthStatus => ({ state: "ok", summary });

  it("is one pending row under the set's title until its rows are known", async () => {
    const { row } = liveSet({ kind: "pending" });
    renderReport([status("a", ok("fine")), row]);
    expect(button().dataset.health).toBe("unknown");
    expect(button().getAttribute("aria-label")).toBe("Checking…");
    expect(dotClass()).toContain("animate-pulse");

    await openReport();
    expect(screen.getByText("Sites")).toBeTruthy();
    expect(summary("Checking…")).toBeTruthy();
  });

  it("is one grey row with the summary when its rows cannot be read", async () => {
    const { row } = liveSet({ kind: "error", summary: "Sites unreadable" });
    renderReport([row]);
    expect(button().dataset.health).toBe("unknown");
    expect(button().getAttribute("aria-label")).toBe("Sites unreadable");
    expect(dotClass()).not.toContain("animate-pulse");
  });

  it("merges each item as its own row, and draws nothing for no items", async () => {
    const { row, set } = liveSet({
      kind: "ready",
      rows: [
        { key: "one", title: "one.example", status: ok("live") },
        {
          key: "two",
          title: "two.example",
          status: { state: "attention", summary: "deploy failed" },
        },
        {
          key: "three",
          title: "three.example",
          status: { state: "critical", summary: "down" },
        },
      ],
    });
    renderReport([status("a", ok("fine")), row]);
    expect(button().dataset.health).toBe("critical");
    expect(button().textContent).toBe("2");
    expect(button().getAttribute("aria-label")).toBe("2 things need attention");

    await openReport();
    expect(screen.getByText("two.example")).toBeTruthy();
    expect(summary("deploy failed")).toBeTruthy();
    expect(summary("down")).toBeTruthy();
    // The ok item folds with the other quiet row.
    expect(summary("All 2 normal")).toBeTruthy();

    set({ kind: "ready", rows: [] });
    expect(button().dataset.health).toBe("ok");
    expect(screen.queryByText("two.example")).toBeNull();
    expect(screen.queryByText("Sites")).toBeNull();
  });

  it("drops an item that vanished from the list", async () => {
    const { row, set } = liveSet({
      kind: "ready",
      rows: [
        { key: "one", title: "one.example", status: ok("live") },
        {
          key: "two",
          title: "two.example",
          status: { state: "critical", summary: "down" },
        },
      ],
    });
    renderReport([row]);
    expect(button().dataset.health).toBe("critical");
    await openReport();
    expect(screen.getByText("two.example")).toBeTruthy();

    set({
      kind: "ready",
      rows: [{ key: "one", title: "one.example", status: ok("live") }],
    });
    expect(button().dataset.health).toBe("ok");
    expect(screen.queryByText("two.example")).toBeNull();
    expect(screen.getByText("one.example")).toBeTruthy();
  });

  it("expands one item at a time, its detail and parts drawn for its key", async () => {
    function Detail({ rowKey }: SetItemProps) {
      return <div data-testid="detail">detail of {rowKey}</div>;
    }
    const { row } = liveSet(
      {
        kind: "ready",
        rows: [
          { key: "one", title: "one.example", status: ok("live") },
          { key: "two", title: "two.example", status: ok("live") },
        ],
      },
      {
        component: Detail,
        actions: ({ rowKey }) => <span>act {rowKey}</span>,
        glance: ({ rowKey, expanded }) => (
          <span>
            glance {rowKey} {expanded ? "open" : "closed"}
          </span>
        ),
      },
    );
    renderReport([row]);
    await openReport();
    expect(screen.getByText("act two")).toBeTruthy();
    expect(screen.queryByTestId("detail")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /two\.example/ }));
    expect(screen.getByTestId("detail").textContent).toBe("detail of two");
    expect(screen.getByText("glance two open")).toBeTruthy();
    expect(screen.getByText("glance one closed")).toBeTruthy();
  });

  it("folds plain items with the other quiet rows", async () => {
    const { row } = liveSet({
      kind: "ready",
      rows: [
        { key: "one", title: "one.example", status: ok("one-summary") },
        { key: "two", title: "two.example", status: ok("two-summary") },
      ],
    });
    renderReport([status("a", ok("a-summary")), row]);
    await openReport();
    expect(summary("All 3 normal")).toBeTruthy();
    expect(screen.queryByText("one-summary")).toBeNull();
  });

  it("greys the dot when its hook throws, files the crash, keeps its siblings", async () => {
    console.error = () => {};
    const reports: BoundaryErrorReport[] = [];
    boundaryReportSink.register((r) => {
      reports.push(r);
    });
    renderReport([
      status("healthy", ok("Server connected")),
      {
        kind: "set",
        id: "sites",
        title: "Sites",
        useRows: () => {
          throw new Error("set exploded");
        },
      },
    ]);
    expect(button().dataset.health).toBe("unknown");
    expect(button().getAttribute("aria-label")).toBe("This check crashed");
    await waitFor(() => expect(reports).toHaveLength(1));
    expect(reports[0]?.error.message).toBe("set exploded");

    await openReport();
    expect(screen.getByText("Sites")).toBeTruthy();
    expect(summary("Server connected")).toBeTruthy();
  });
});
