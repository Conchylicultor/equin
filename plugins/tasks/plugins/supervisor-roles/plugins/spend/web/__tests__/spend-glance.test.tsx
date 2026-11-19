/**
 * The Spent this week glance, through its real hooks with the live reads
 * stubbed: a skeleton until the accounts, their usage and the spend are all
 * known — never a $0 stand-in — then the total and one legend entry per
 * category, in the categories' order.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock(
  "@plugins/primitives/plugins/log-channels/web",
  async (importOriginal) => ({
    ...(await importOriginal<object>()),
    clientLog: () => {},
  }),
);

const live = vi.hoisted(() => ({ spend: undefined as unknown, ready: true }));

vi.mock("@plugins/network/plugins/live/web", async (importOriginal) => {
  const core = await import("../../core");
  const refetch = () => Promise.resolve();
  return {
    ...(await importOriginal<object>()),
    useLive: (decl: unknown, query?: unknown) => {
      if (decl === core.supervisorsSpend)
        return query === null || live.spend === undefined
          ? { status: "loading", refetch }
          : { status: "ready", data: live.spend, refetch };
      if (!live.ready) return { status: "loading", refetch };
      // claudeAccounts / claudeUsage: one plan account with no reading yet.
      return {
        status: "ready",
        data: {
          accounts: [],
          active: "system",
          byAccount: {},
        },
        refetch,
      };
    },
  };
});

import { cleanup, render } from "@testing-library/react";
import type { SpendNode } from "../../core";
import {
  createTestSurfaceStore,
  TestSurface,
} from "@plugins/primitives/plugins/pane/web/testing";
import { SpendGlance } from "../components/spend-glance";

/** The glance, in a pane surface as the Supervisors list mounts it. */
function renderGlance() {
  return render(
    <TestSurface store={createTestSurfaceStore({ live: false })}>
      <SpendGlance />
    </TestSurface>,
  );
}

const node = (
  id: string,
  costUsd: number,
  children: SpendNode[] = [],
  short: string | null = null,
): SpendNode => ({
  id,
  kind: children.length > 0 || id === "week" ? "category" : "conversation",
  name: id,
  short,
  sub: null,
  costUsd,
  billedUsd: 0,
  live: false,
  conversationId: null,
  count: null,
  children,
});

afterEach(() => {
  cleanup();
  live.spend = undefined;
  live.ready = true;
});

describe("SpendGlance", () => {
  it("shows a skeleton, not $0, until the spend is known", () => {
    const { container, queryByText } = renderGlance();
    expect(queryByText(/\$0/)).toBeNull();
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
  });

  it("shows the total and each category's share once read", () => {
    live.spend = {
      tree: node("week", 100, [
        node("supervisors", 75, [node("a", 75)], "Supervisors"),
        node("you", 25, [node("b", 25)], "You"),
      ]),
      attributedSince: null,
    };
    const { getByText, container } = renderGlance();
    expect(getByText("$100")).toBeTruthy();
    const legend = [...container.querySelectorAll(".sg-legend > span")].map(
      (s) => s.textContent,
    );
    expect(legend).toEqual(["Supervisors75%", "You25%"]);
    expect(container.querySelectorAll(".sp-bar > i")).toHaveLength(2);
  });
});
