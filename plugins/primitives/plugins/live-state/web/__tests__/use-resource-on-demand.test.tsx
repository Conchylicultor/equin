/**
 * A pushed descriptor (a `liveValue`) waits for the WS sub-ack to
 * fill its cache — its HTTP `queryFn` is only the fallback, so the query stays
 * disabled until a value lands. An on-demand descriptor (`load: "on-demand"`,
 * the server's `invalidate` mode) never gets that value over the socket: HTTP is
 * its read path. This suite pins both halves against a real `QueryClient`:
 *
 *   - on-demand ⇒ fetched over HTTP on mount, and settles;
 *   - pushed ⇒ no HTTP read on mount, pending until the sub-ack value lands.
 *
 * Regression: `edited-files` declared as a `liveValue` stayed pending forever,
 * leaving the conversation's Close button disabled.
 *
 * Harness mirrors use-resource-error-gate: a `createLiveStateHarness` pair,
 * `fetchOverHttp` spied, cold-start primer suppressed, `clientLog` mocked.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@plugins/primitives/plugins/log-channels/web", () => ({
  clientLog: () => {},
}));

import { act, renderHook, waitFor } from "@testing-library/react";
import { z } from "zod";
import {
  queryKeyFor,
  useResource,
} from "@plugins/primitives/plugins/live-state/web";
import type { ResourceDescriptor } from "@plugins/primitives/plugins/live-state/core";
import { createLiveStateHarness, type LiveStateHarness } from "../testing";

const Count = z.object({ n: z.number() });

const onDemand: ResourceDescriptor<{ n: number }> = {
  key: "test.on-demand.value",
  schema: Count,
  load: "on-demand",
  validateParams: () => {},
};
const pushed: ResourceDescriptor<{ n: number }> = {
  key: "test.pushed.value",
  schema: Count,
  validateParams: () => {},
};

// React Query's own refetch-on-mount, as the app's client has it.
function makeClient(): LiveStateHarness {
  return createLiveStateHarness({ queries: { refetchOnMount: true } });
}

function mount<R>(
  live: LiveStateHarness,
  fetched: { n: number },
  useHook: () => R,
) {
  // Spied before the hook's query runs.
  vi.spyOn(live.notifications, "hasEverBeenReady").mockReturnValue(true);
  const fetchOverHttp = vi
    .spyOn(live.notifications, "fetchOverHttp")
    .mockResolvedValue(fetched);
  const rendered = renderHook(useHook, { wrapper: live.Wrapper });
  return { ...rendered, fetchOverHttp };
}

describe("useResource — pushed and on-demand descriptors", () => {
  afterEach(() => vi.restoreAllMocks());

  it("an on-demand value is read over HTTP on mount and settles", async () => {
    const { result, fetchOverHttp } = mount(makeClient(), { n: 7 }, () =>
      useResource(onDemand),
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));
    const r = result.current;
    if (r.status !== "ready") throw new Error("unreachable");
    expect(r.data).toEqual({ n: 7 });
    expect(fetchOverHttp).toHaveBeenCalledWith(
      onDemand.key,
      {},
      undefined,
      onDemand,
      "fallback",
    );
  });

  it("a pushed value waits for the sub-ack — no HTTP read on mount", async () => {
    const live = makeClient();
    const { result, fetchOverHttp } = mount(live, { n: 1 }, () =>
      useResource(pushed),
    );
    expect(result.current.status).toBe("loading");
    act(() => {
      live.queryClient.setQueryData(queryKeyFor(pushed.key, undefined), {
        n: 2,
      });
    });
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(fetchOverHttp).not.toHaveBeenCalled();
  });
});
