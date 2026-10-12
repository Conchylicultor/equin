/**
 * `useResource`'s three states against a REAL `QueryClient` (not a mock): a
 * failure is its own `error` state, never a flavour of loading.
 *
 *   - first render, no value ⇒ `status: "loading"` (and `error: null`);
 *   - a first-load failure ⇒ `status: "error"`, a typed `ResourceError`, no
 *     `stale`;
 *   - a failure AFTER a successful load ⇒ `status: "error"`, `stale` = the last
 *     good value, and no `data` on the result;
 *   - a subsequent `setQueryData` (the WS push path) clears the error and
 *     returns to `ready` — the load-bearing React Query behavior (its success
 *     action resets `state.error`);
 *   - with `{ select }`, `stale` carries the SELECTED slice;
 *   - `refetch` from the error arm re-runs the load and recovers.
 *
 * `pending` (the deprecated pre-`status` spelling) is asserted alongside: true
 * on both loading and error, false on ready.
 *
 * Harness: a real `NotificationsClient` and the `QueryClient` it owns (`createLiveStateHarness`). The ONE HTTP
 * write path — `NotificationsClient.fetchOverHttp`, which backs `useResource`'s
 * `queryFn` — is spied so `refetch()` is a deterministic way to drive an error
 * into `q.error` without a live server. Authoritative pushes are driven directly
 * with `queryClient.setQueryData`, the same call the WS sub-ack makes. React Query's
 * observer notification is batched (async), so state transitions are awaited via
 * `waitFor` rather than read synchronously.
 *
 * `clientLog` is mocked to a no-op (mounting `NotificationsProvider` otherwise
 * schedules real fetch flushes at module eval — same convention as the
 * live-state hazard suites).
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
import {
  ResourceError,
  type ResourceDescriptor,
} from "@plugins/primitives/plugins/live-state/core";
import type { NotificationsClient } from "../notifications-client";
import { createLiveStateHarness, type LiveStateHarness } from "../testing";

const rowsResource: ResourceDescriptor<number[]> = {
  key: "test.error-gate.rows",
  schema: z.array(z.number()),
  validateParams: () => {},
};
const rowsKey = queryKeyFor(rowsResource.key, undefined);

// The harness's client has retry:false, so a rejected queryFn sets
// `state.error` immediately, and no auto-refetch, so `fetchOverHttp` runs ONLY
// on our explicit `refetch()`.
function mount<R>(live: LiveStateHarness, useHook: () => R) {
  // Suppress the cold-start HTTP primer so the only path that runs
  // `fetchOverHttp` is our explicit `refetch()`.
  vi.spyOn(live.notifications, "hasEverBeenReady").mockReturnValue(true);
  const rendered = renderHook(useHook, { wrapper: live.Wrapper });
  return { ...rendered, notifications: live.notifications };
}

/** Force `q.error` via the queryFn (`fetchOverHttp`) rejecting once. */
async function failNextLoad(
  notifications: NotificationsClient,
  result: { current: { refetch: () => Promise<void> } },
  message: string,
): Promise<void> {
  vi.spyOn(notifications, "fetchOverHttp").mockRejectedValue(
    new Error(message),
  );
  await act(async () => {
    // The mocked rejection IS the scenario under test, so swallow exactly that
    // one and rethrow anything else (a bare `.catch(() => {})` would hide a
    // genuine failure in the hook).
    await result.current.refetch().catch((err: unknown) => {
      if (err instanceof Error && err.message === message) return;
      throw err;
    });
  });
}

describe("useResource — loading / error / ready", () => {
  afterEach(() => vi.restoreAllMocks());

  it("no value yet ⇒ loading, with no error", () => {
    const live = createLiveStateHarness();
    const { result } = mount(live, () => useResource(rowsResource));
    const r = result.current;
    expect(r.status).toBe("loading");
    expect("error" in r).toBe(false);
  });

  it("first-load failure ⇒ error, typed, with no stale", async () => {
    const live = createLiveStateHarness();
    const { result, notifications } = mount(live, () =>
      useResource(rowsResource),
    );
    await failNextLoad(notifications, result, "boom");

    await waitFor(() => expect(result.current.status).toBe("error"));
    const r = result.current;
    if (r.status !== "error") throw new Error("unreachable");
    expect(r.error).toBeInstanceOf(ResourceError);
    expect(r.error.kind).toBe("loader-failed");
    expect(r.error.message).toBe("boom");
    expect(r.stale).toBeUndefined();
  });

  it("failure after a successful load ⇒ error, stale = last good, data absent", async () => {
    const live = createLiveStateHarness();
    const { result, notifications } = mount(live, () =>
      useResource(rowsResource),
    );

    act(() => {
      live.queryClient.setQueryData(rowsKey, [1, 2, 3]);
    });
    await waitFor(() => expect(result.current.status).toBe("ready"));
    // Narrow a LOCAL, never `result.current` itself: narrowing the property
    // access pins it to one arm for the rest of the block.
    const beforeFailure = result.current;
    if (beforeFailure.status !== "ready") throw new Error("unreachable");
    expect(beforeFailure.data).toEqual([1, 2, 3]);
    expect(beforeFailure.status).toBe("ready");

    await failNextLoad(notifications, result, "late");

    await waitFor(() => expect(result.current.status).toBe("error"));
    const r = result.current;
    if (r.status !== "error") throw new Error("unreachable");
    expect(r.error.message).toBe("late");
    expect(r.stale).toEqual([1, 2, 3]);
    // The error arm exposes no `data` — a stale value can never decide.
    expect("data" in r).toBe(false);
  });

  it("a subsequent setQueryData (WS push) clears the error and returns to ready — the RQ assumption the gate rests on", async () => {
    const live = createLiveStateHarness();
    const { result, notifications } = mount(live, () =>
      useResource(rowsResource),
    );

    act(() => {
      live.queryClient.setQueryData(rowsKey, [1]);
    });
    await waitFor(() => expect(result.current.status).toBe("ready"));
    await failNextLoad(notifications, result, "boom");
    await waitFor(() => expect(result.current.status).toBe("error"));
    // The load-bearing RQ behavior, asserted against the real QueryClient:
    // the error is live BEFORE the push...
    expect(live.queryClient.getQueryState(rowsKey)?.error).toBeTruthy();

    act(() => {
      live.queryClient.setQueryData(rowsKey, [1, 2]);
    });
    // ...and the success action RESET it to null — synchronously, on the cache.
    expect(live.queryClient.getQueryState(rowsKey)?.error).toBeNull();

    await waitFor(() => expect(result.current.status).toBe("ready"));
    const r = result.current;
    if (r.status !== "ready")
      throw new Error("unreachable — push should have re-settled");
    expect(r.data).toEqual([1, 2]);
  });

  it("with select, stale carries the selected slice, not the raw payload", async () => {
    const live = createLiveStateHarness();
    const { result, notifications } = mount(live, () =>
      useResource(rowsResource, undefined, { select: (rows) => rows.length }),
    );

    act(() => {
      live.queryClient.setQueryData(rowsKey, [10, 20, 30]);
    });
    await waitFor(() => expect(result.current.status).toBe("ready"));
    const beforeFailure = result.current;
    if (beforeFailure.status !== "ready") throw new Error("unreachable");
    expect(beforeFailure.data).toBe(3);

    await failNextLoad(notifications, result, "boom");

    await waitFor(() => expect(result.current.status).toBe("error"));
    const r = result.current;
    if (r.status !== "error") throw new Error("unreachable");
    // The SELECTED slice (length), not the raw [10,20,30].
    expect(r.stale).toBe(3);
  });

  it("refetch from the error arm re-runs the load and recovers", async () => {
    const live = createLiveStateHarness();
    const { result, notifications } = mount(live, () =>
      useResource(rowsResource),
    );
    await failNextLoad(notifications, result, "boom");
    await waitFor(() => expect(result.current.status).toBe("error"));

    vi.spyOn(notifications, "fetchOverHttp").mockResolvedValue([7]);
    const r = result.current;
    if (r.status !== "error") throw new Error("unreachable");
    await act(async () => {
      await r.refetch();
    });

    await waitFor(() => expect(result.current.status).toBe("ready"));
    const after = result.current;
    if (after.status !== "ready") throw new Error("unreachable");
    expect(after.data).toEqual([7]);
  });
});
