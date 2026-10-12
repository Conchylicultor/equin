import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mounting NotificationsProvider otherwise schedules real fetch flushes at
// module eval — the convention the live-state hazard suites established.
vi.mock("@plugins/primitives/plugins/log-channels/web", () => ({
  clientLog: () => {},
}));

import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
} from "@testing-library/react";
import { queryKeyFor } from "@plugins/primitives/plugins/live-state/web";
import {
  createLiveStateHarness,
  markResourceContractMismatch,
  resetResourceContractMismatches,
} from "@plugins/primitives/plugins/live-state/web/testing";
import { markDeferredPluginsFailed } from "@plugins/framework/plugins/web-sdk/core";
import { resetDeferredLoadStateForTests } from "@plugins/framework/plugins/web-sdk/core/testing";
import {
  deployment,
  type DeploymentState,
} from "@plugins/build/plugins/deployment/core";
import { useReloadAdvice, type ReloadAdvice } from "../hooks/use-reload-advice";
import { ReloadButton } from "../components/reload-button";

/**
 * The Reload pill of the Build tray, and the one signal behind it.
 *
 * `useReloadAdvice` reads two things: the deployment resource (is the server
 * serving a different frontend than this tab runs?) and the page-global
 * deferred-load store (did a plugin fail to load?). Both are driven directly —
 * the resource by seeding its query the way the live-state suites do, the store
 * through its own writers — so nothing here needs a server.
 */

const BAKED = "graph-baked";

/** A deployment whose `web` carrier serves `graph`. */
function servingGraph(graph: string): DeploymentState {
  const unresolved = { resolved: false as const, reason: "test" };
  return {
    kind: "unknown",
    reason: "test",
    deployable: [
      {
        id: "web",
        commit: unresolved,
        graph: { resolved: true, value: graph },
        ancestorOfTarget: unresolved,
      },
    ],
  };
}

function wrapperServing(graph: string) {
  const live = createLiveStateHarness();
  live.queryClient.setQueryData(
    queryKeyFor(deployment.key, undefined),
    servingGraph(graph),
  );
  return live.Wrapper;
}

beforeEach(() => {
  // The graph hash baked into "this tab's" bundle. Without it the hook is inert
  // (a dev server has no baked graph), and no tab could ever read as stale.
  vi.stubEnv("VITE_BUILD_GRAPH", BAKED);
  resetDeferredLoadStateForTests();
  resetResourceContractMismatches();
});

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  resetDeferredLoadStateForTests();
  resetResourceContractMismatches();
});

describe("useReloadAdvice", () => {
  it("is none when the server serves this tab's own bundle and nothing failed", () => {
    const { result } = renderHook(() => useReloadAdvice(), {
      wrapper: wrapperServing(BAKED),
    });
    expect(result.current).toEqual({ kind: "none" });
  });

  it("is stale when the server serves a different bundle", () => {
    const { result } = renderHook(() => useReloadAdvice(), {
      wrapper: wrapperServing("graph-newer"),
    });
    expect(result.current).toEqual({ kind: "stale" });
  });

  it("is broken when a plugin failed, counting the failures", () => {
    markDeferredPluginsFailed([
      "apps/plugins/website/plugins/landing/plugins/contact",
      "apps/plugins/story/plugins/lenses",
    ]);
    const { result } = renderHook(() => useReloadAdvice(), {
      wrapper: wrapperServing(BAKED),
    });
    expect(result.current).toEqual({
      kind: "broken",
      stale: false,
      failedCount: 2,
    });
  });

  it("keeps the stale bit when the tab is both broken and stale", () => {
    markDeferredPluginsFailed(["apps/plugins/story/plugins/lenses"]);
    const { result } = renderHook(() => useReloadAdvice(), {
      wrapper: wrapperServing("graph-newer"),
    });
    expect(result.current).toEqual({
      kind: "broken",
      stale: true,
      failedCount: 1,
    });
  });

  it("is outdated when the server refused resources for skew, counting them", () => {
    markResourceContractMismatch({
      key: "build.history",
      reason: "contract-mismatch",
      verdict: "skew",
    });
    markResourceContractMismatch({
      key: "gone.key",
      reason: "unknown-key",
      verdict: "skew",
    });
    // A same-build / unknown verdict is a bug, not an out-of-date tab.
    markResourceContractMismatch({
      key: "bug.key",
      reason: "contract-mismatch",
      verdict: "same-build",
    });
    const { result } = renderHook(() => useReloadAdvice(), {
      wrapper: wrapperServing("graph-newer"),
    });
    expect(result.current).toEqual({ kind: "outdated", stale: true, count: 2 });
  });

  it("precedence: broken > outdated > stale", () => {
    markResourceContractMismatch({
      key: "build.history",
      reason: "contract-mismatch",
      verdict: "skew",
    });
    markDeferredPluginsFailed(["apps/plugins/story/plugins/lenses"]);
    const { result } = renderHook(() => useReloadAdvice(), {
      wrapper: wrapperServing(BAKED),
    });
    // An outdated tab is a stale one: the broken copy names both.
    expect(result.current).toEqual({
      kind: "broken",
      stale: true,
      failedCount: 1,
    });
  });

  it("turns outdated the moment a mismatch is recorded, without a remount", () => {
    const { result, rerender } = renderHook(() => useReloadAdvice(), {
      wrapper: wrapperServing(BAKED),
    });
    expect(result.current.kind).toBe("none");
    act(() =>
      markResourceContractMismatch({
        key: "build.history",
        reason: "contract-mismatch",
        verdict: "skew",
      }),
    );
    rerender();
    expect(result.current).toEqual({
      kind: "outdated",
      stale: false,
      count: 1,
    });
  });

  it("turns broken the moment a failure is published, without a remount", () => {
    const { result, rerender } = renderHook(() => useReloadAdvice(), {
      wrapper: wrapperServing(BAKED),
    });
    expect(result.current.kind).toBe("none");
    markDeferredPluginsFailed(["apps/plugins/story/plugins/lenses"]);
    rerender();
    expect(result.current.kind).toBe("broken");
  });
});

const STALE_ONLY = "Server was rebuilt — click to reload this tab";
const BROKEN_ONLY = "Part of the app didn't load — reload to fix";
const BOTH =
  "This tab is out of date and part of the app didn't load — reload to fix";
const OUTDATED =
  "This tab is out of date and can't load some data — reload to fix";

describe("ReloadButton", () => {
  it("renders nothing when no reload is needed", () => {
    const { container } = render(<ReloadButton advice={{ kind: "none" }} />);
    expect(container.textContent).toBe("");
  });

  const cases: Array<{
    name: string;
    advice: ReloadAdvice;
    message: string;
    tint: string;
    notTint: string;
  }> = [
    {
      name: "stale only → blue, rebuilt copy",
      advice: { kind: "stale" },
      message: STALE_ONLY,
      tint: "bg-info-solid",
      notTint: "bg-destructive-solid",
    },
    {
      name: "failed only → red, didn't-load copy",
      advice: { kind: "broken", stale: false, failedCount: 3 },
      message: BROKEN_ONLY,
      tint: "bg-destructive-solid",
      notTint: "bg-info-solid",
    },
    {
      name: "outdated → red, can't-load copy",
      advice: { kind: "outdated", stale: true, count: 1 },
      message: OUTDATED,
      tint: "bg-destructive-solid",
      notTint: "bg-info-solid",
    },
    {
      name: "failed and stale → red, copy names both",
      advice: { kind: "broken", stale: true, failedCount: 1 },
      message: BOTH,
      tint: "bg-destructive-solid",
      notTint: "bg-info-solid",
    },
  ];

  for (const c of cases) {
    it(c.name, () => {
      const { getByRole } = render(<ReloadButton advice={c.advice} />);
      // The accessible name carries the whole message: colour and a hover
      // tooltip are otherwise the only difference between the two states.
      const pill = getByRole("button", { name: c.message });
      expect(pill.textContent).toBe("Reload");
      expect(pill.className).toContain(c.tint);
      expect(pill.className).not.toContain(c.notTint);
    });
  }

  it("is a real <button> of its own, not nested in the Build button", () => {
    const { getByRole } = render(
      <ReloadButton
        advice={{ kind: "broken", stale: false, failedCount: 1 }}
      />,
    );
    const pill = getByRole("button", { name: BROKEN_ONLY });
    expect(pill.tagName).toBe("BUTTON");
    expect(pill.parentElement?.closest("button")).toBeNull();
  });

  it("shows its message as a tooltip on hover", async () => {
    const { getByRole, findByText } = render(
      <ReloadButton advice={{ kind: "broken", stale: true, failedCount: 1 }} />,
    );
    const pill = getByRole("button", { name: BOTH });
    fireEvent.pointerEnter(pill, { pointerType: "mouse" });
    fireEvent.mouseEnter(pill);
    fireEvent.focus(pill);
    // The tooltip popup, not the pill's own aria-label.
    expect(
      await findByText(BOTH, { selector: "*:not([role=button]):not(button)" }),
    ).not.toBeNull();
  });

  describe("pressing it", () => {
    const reload = vi.fn();
    const realLocation = window.location;

    beforeEach(() => {
      reload.mockReset();
      Object.defineProperty(window, "location", {
        configurable: true,
        value: { ...realLocation, reload },
      });
    });

    afterEach(() => {
      Object.defineProperty(window, "location", {
        configurable: true,
        value: realLocation,
      });
    });

    it("reloads the tab", () => {
      const { getByRole } = render(<ReloadButton advice={{ kind: "stale" }} />);
      fireEvent.click(getByRole("button", { name: STALE_ONLY }));
      expect(reload).toHaveBeenCalledTimes(1);
    });
  });
});
