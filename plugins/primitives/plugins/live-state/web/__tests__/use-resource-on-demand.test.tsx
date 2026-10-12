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
 * Harness mirrors use-resource-error-gate: real `NotificationsProvider`,
 * `fetchOverHttp` spied, cold-start primer suppressed, `clientLog` mocked.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@plugins/primitives/plugins/log-channels/web", () => ({
  clientLog: () => {},
}));

import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient } from "@tanstack/react-query";
import { type ReactNode } from "react";
import { z } from "zod";
import {
  NotificationsProvider,
  getNotificationsClient,
  queryKeyFor,
  useResource,
} from "@plugins/primitives/plugins/live-state/web";
import type { ResourceDescriptor } from "@plugins/primitives/plugins/live-state/core";

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

function makeClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
}

function mount<R>(
  client: QueryClient,
  fetched: { n: number },
  useHook: () => R,
) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <NotificationsProvider queryClient={client}>
      {children}
    </NotificationsProvider>
  );
  // The provider creates the client on first render; spy before the hook's
  // query runs by rendering a no-op first.
  const probe = renderHook(() => null, { wrapper });
  const notifications = getNotificationsClient();
  if (!notifications) throw new Error("NotificationsClient not created");
  vi.spyOn(notifications, "hasEverBeenReady").mockReturnValue(true);
  const fetchOverHttp = vi
    .spyOn(notifications, "fetchOverHttp")
    .mockResolvedValue(fetched);
  probe.unmount();
  const rendered = renderHook(useHook, { wrapper });
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
    const client = makeClient();
    const { result, fetchOverHttp } = mount(client, { n: 1 }, () =>
      useResource(pushed),
    );
    expect(result.current.status).toBe("loading");
    act(() => {
      client.setQueryData(queryKeyFor(pushed.key, undefined), { n: 2 });
    });
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(fetchOverHttp).not.toHaveBeenCalled();
  });
});
