import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mounting NotificationsProvider otherwise schedules real fetch flushes at
// module eval — the convention the live-state hazard suites established.
vi.mock(
  "@plugins/primitives/plugins/log-channels/web",
  async (importOriginal) => ({
    ...(await importOriginal<object>()),
    clientLog: () => {},
  }),
);

import { act, cleanup, renderHook } from "@testing-library/react";
import { queryKeyFor } from "@plugins/network/plugins/live/plugins/live-state/web";
import {
  clearResourceContractMismatch,
  createLiveStateHarness,
  markResourceContractMismatch,
  resetResourceContractMismatches,
} from "@plugins/network/plugins/live/plugins/live-state/web/testing";
import { markDeferredPluginsFailed } from "@plugins/framework/plugins/web-sdk/core";
import { resetDeferredLoadStateForTests } from "@plugins/framework/plugins/web-sdk/core/testing";
import {
  deployment,
  type DeploymentState,
} from "@plugins/build/plugins/deployment/core";
import { useServerBehind, useTabUpdate } from "../hooks/use-tab-update";

/**
 * The one verdict behind the update policy and the Update pill: the version
 * this tab runs against the version served.
 *
 * `useTabUpdate` reads the deployment resource (is the server serving a
 * different frontend than this tab runs?), the server's skew refusals, and the
 * page-global deferred-load store (did a plugin fail to load?). All are driven
 * directly — the resource by seeding its query the way the live-state suites
 * do, the stores through their own writers — so nothing here needs a server.
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

const SKEW = {
  params: {},
  key: "build.history",
  reason: "contract-mismatch",
  verdict: "skew",
} as const;

describe("useTabUpdate", () => {
  it("is current when the server serves this tab's own bundle and nothing failed", () => {
    const { result } = renderHook(() => useTabUpdate(), {
      wrapper: wrapperServing(BAKED),
    });
    expect(result.current).toEqual({ kind: "current" });
  });

  it("is an available update when the server serves a different bundle", () => {
    const { result } = renderHook(() => useTabUpdate(), {
      wrapper: wrapperServing("graph-newer"),
    });
    expect(result.current).toEqual({
      kind: "available",
      target: "graph-newer",
    });
  });

  it("is current while the served graph is unknown", () => {
    const live = createLiveStateHarness();
    const { result } = renderHook(() => useTabUpdate(), {
      wrapper: live.Wrapper,
    });
    expect(result.current).toEqual({ kind: "current" });
  });

  it("a plugin failure on the served build is a fault, naming the plugins", () => {
    markDeferredPluginsFailed([
      "apps/plugins/website/plugins/landing/plugins/contact",
      "apps/plugins/story/plugins/lenses",
    ]);
    const { result } = renderHook(() => useTabUpdate(), {
      wrapper: wrapperServing(BAKED),
    });
    expect(result.current).toEqual({
      kind: "fault",
      failedPaths: [
        "apps/plugins/story/plugins/lenses",
        "apps/plugins/website/plugins/landing/plugins/contact",
      ],
    });
  });

  it("a plugin failure on an older build is a required update: the version change explains it", () => {
    markDeferredPluginsFailed(["apps/plugins/story/plugins/lenses"]);
    const { result } = renderHook(() => useTabUpdate(), {
      wrapper: wrapperServing("graph-newer"),
    });
    expect(result.current).toEqual({
      kind: "required",
      why: "missing-plugins",
      count: 1,
      target: "graph-newer",
    });
  });

  it("skew refusals of an older tab are a required update, counting them", () => {
    markResourceContractMismatch(SKEW);
    markResourceContractMismatch({
      params: {},
      key: "gone.key",
      reason: "unknown-key",
      verdict: "skew",
    });
    // A same-build / unknown verdict is a bug, not an out-of-date tab.
    markResourceContractMismatch({
      params: {},
      key: "bug.key",
      reason: "contract-mismatch",
      verdict: "same-build",
    });
    const { result } = renderHook(() => useTabUpdate(), {
      wrapper: wrapperServing("graph-newer"),
    });
    expect(result.current).toEqual({
      kind: "required",
      why: "outdated",
      count: 2,
      target: "graph-newer",
    });
  });

  it("skew refusals while the served graph is unknown: required, toward an unknown target", () => {
    markResourceContractMismatch(SKEW);
    const live = createLiveStateHarness();
    const { result } = renderHook(() => useTabUpdate(), {
      wrapper: live.Wrapper,
    });
    expect(result.current).toEqual({
      kind: "required",
      why: "outdated",
      count: 1,
      target: null,
    });
  });

  it("a plugin failure under skew refusals is explained by the version change", () => {
    markResourceContractMismatch(SKEW);
    markDeferredPluginsFailed(["apps/plugins/story/plugins/lenses"]);
    const { result } = renderHook(() => useTabUpdate(), {
      wrapper: wrapperServing("graph-newer"),
    });
    expect(result.current).toMatchObject({
      kind: "required",
      why: "missing-plugins",
    });
  });

  it("a skew refusal of a tab running the served bundle is the server's, not an update", () => {
    markResourceContractMismatch({
      params: {},
      key: "db-lock-watch",
      reason: "unknown-key",
      verdict: "skew",
    });
    const wrapper = wrapperServing(BAKED);
    const update = renderHook(() => useTabUpdate(), { wrapper });
    const behind = renderHook(() => useServerBehind(), { wrapper });
    expect(update.result.current).toEqual({ kind: "current" });
    expect(behind.result.current).toEqual({ behind: true, count: 1 });
  });

  it("a plugin failure under a server that is behind is a fault, not an update", () => {
    markResourceContractMismatch({
      params: {},
      key: "db-lock-watch",
      reason: "unknown-key",
      verdict: "skew",
    });
    markDeferredPluginsFailed(["apps/plugins/story/plugins/lenses"]);
    const { result } = renderHook(() => useTabUpdate(), {
      wrapper: wrapperServing(BAKED),
    });
    expect(result.current.kind).toBe("fault");
  });

  it("a server that catches up clears it: the refused tuple is answered", () => {
    const { result, rerender } = renderHook(() => useServerBehind(), {
      wrapper: wrapperServing(BAKED),
    });
    act(() =>
      markResourceContractMismatch({
        params: {},
        key: "db-lock-watch",
        reason: "unknown-key",
        verdict: "skew",
      }),
    );
    rerender();
    expect(result.current.behind).toBe(true);
    act(() => clearResourceContractMismatch("db-lock-watch", {}));
    rerender();
    expect(result.current).toEqual({ behind: false });
  });

  it("turns required the moment a mismatch is recorded, without a remount", () => {
    const { result, rerender } = renderHook(() => useTabUpdate(), {
      wrapper: wrapperServing("graph-newer"),
    });
    expect(result.current.kind).toBe("available");
    act(() => markResourceContractMismatch(SKEW));
    rerender();
    expect(result.current.kind).toBe("required");
  });
});
