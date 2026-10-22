/**
 * Hook-shell tests for `useOptimisticResource`. The pure op lifecycle is pinned
 * by `internal/overlay.test.ts` (bun:test); what only a render can exercise is
 * the WIRING: the dispatch-time `dataUpdateCount` stamp, the QueryCache
 * "updated" subscription, the resolve edge confirming against a push that had
 * ALREADY landed, the keep-rendered failure model (never-revert), the
 * reconnect auto-retry, and the watermark-registry read behind causal denial.
 *
 * `clientLog` is mocked to a no-op (mounting `NotificationsProvider` otherwise
 * schedules real fetch flushes at module eval — same convention as the
 * live-state hazard suites).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@plugins/primitives/plugins/log-channels/web", () => ({
  clientLog: () => {},
}));

import { act, render, renderHook, waitFor } from "@testing-library/react";
import { useEffect } from "react";
import { z } from "zod";
import { queryKeyFor } from "@plugins/primitives/plugins/live-state/web";
import { textField } from "@plugins/fields/plugins/text/plugins/config/core";
import { liveCollection, liveValue } from "@plugins/network/plugins/live/core";
import {
  createLiveStateHarness,
  mergeKeyedDelta,
  noteResourceTxAcks,
  noteResourceWatermark,
  NotificationsClient,
  type LiveStateHarness,
} from "@plugins/primitives/plugins/live-state/web/testing";
import { EndpointError } from "@plugins/infra/plugins/endpoints/web";
import {
  clientLatencySink,
  type ClientLatencySample,
} from "@plugins/primitives/plugins/perfs/plugins/latency-signal/core";
import {
  SyncStatusIndicator,
  SyncStatusProvider,
} from "@plugins/primitives/plugins/sync-status/web";
import {
  useOptimisticResource,
  type OptimisticOptions,
} from "../internal/use-optimistic-resource";
import {
  activeSendLaneCount,
  enqueueDetachedWrite,
  enqueueResourceWrite,
} from "../internal/send-lane";
import {
  optimisticDivergenceReportSink,
  optimisticRejectionSink,
} from "../reporter";
import type {
  OptimisticDivergenceReport,
  OptimisticRejectionReport,
} from "../reporter";

const Numbers = z.array(z.number());

const rowsValue = liveValue("test.optimistic-mutation.rows", {
  schema: Numbers,
});
const rowsKey = queryKeyFor(rowsValue.key, undefined);

// A dedicated value for the causal-denial test: the watermark registry is
// module-level and monotonic, so seeding it must not leak into other tests.
const denialValue = liveValue("test.optimistic-mutation.denial", {
  schema: Numbers,
});
const denialKey = queryKeyFor(denialValue.key, undefined);

// The same holds for the tx-ack registry and the send lanes (both module-level):
// every case that notes an ack or pins lane behaviour reads a key of its own.
const ackRaceValue = liveValue("test.optimistic-mutation.ack-race", {
  schema: Numbers,
});
const ackStandaloneValue = liveValue(
  "test.optimistic-mutation.ack-standalone",
  { schema: Numbers },
);
const ackRebaseValue = liveValue("test.optimistic-mutation.ack-rebase", {
  schema: Numbers,
  params: ["v"],
});
const laneOrderValue = liveValue("test.optimistic-mutation.lane-order", {
  schema: Numbers,
});
const laneWedgeValue = liveValue("test.optimistic-mutation.lane-wedge", {
  schema: Numbers,
});
const laneRejectValue = liveValue("test.optimistic-mutation.lane-reject", {
  schema: Numbers,
});
const laneSharedValue = liveValue("test.optimistic-mutation.lane-shared", {
  schema: Numbers,
});
const laneDetachedValue = liveValue("test.optimistic-mutation.lane-detached", {
  schema: Numbers,
});
const laneReclaimValue = liveValue("test.optimistic-mutation.lane-reclaim", {
  schema: Numbers,
});

type NumbersValue = typeof rowsValue;

const apply = (current: number[], n: number): number[] => [...current, n];
const isConfirmedBy = (serverData: number[], n: number): boolean =>
  serverData.includes(n);
const sameTarget = (a: number, b: number): boolean => a === b;

type MutateResult = void | { watermark?: string };

/** A `mutate` whose promise the test resolves by hand, to order push vs resolve. */
function deferredMutate() {
  let release!: (res?: MutateResult) => void;
  const mutate = vi.fn(
    () =>
      new Promise<MutateResult>((resolve) => {
        release = resolve;
      }),
  );
  return { mutate, release: (res?: MutateResult) => release(res) };
}

/** A `mutate` the test settles BY CALL, so send order is directly observable. */
function queuedMutate() {
  const calls: Array<{
    vars: number;
    resolve: (res?: MutateResult) => void;
    reject: (err: unknown) => void;
  }> = [];
  const mutate = vi.fn(
    (n: number) =>
      new Promise<MutateResult>((resolve, reject) => {
        calls.push({ vars: n, resolve, reject });
      }),
  );
  return { mutate, calls, sent: () => calls.map((c) => c.vars) };
}

/** Drain the microtask + timer queues, so "did NOT fire" assertions mean it. */
async function settleQueues(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

/**
 * The transport counts as having been ready (like `useLive`'s suite), so no
 * cold-start HTTP prime races the hand-written `setQueryData` values.
 */
function markTransportReady(live: LiveStateHarness): void {
  vi.spyOn(live.notifications, "hasEverBeenReady").mockReturnValue(true);
}

function mountPositional<R>(live: LiveStateHarness, useHook: () => R) {
  const rendered = renderHook(useHook, { wrapper: live.Wrapper });
  markTransportReady(live);
  return rendered;
}

/** Wait for the settled arm and return it. */
async function settledOf<R extends { status: string }>(result: {
  current: R;
}): Promise<Extract<R, { status: "ready" }>> {
  await waitFor(() => expect(result.current.status).toBe("ready"));
  return result.current as Extract<R, { status: "ready" }>;
}

/** The settled arm, now — throws (so a `waitFor` retries) while pending. */
function settledArm<R extends { status: string }>(
  r: R,
): Extract<R, { status: "ready" }> {
  if (r.status !== "ready") throw new Error("expected the settled arm");
  return r as Extract<R, { status: "ready" }>;
}

/**
 * `contentBased` picks the confirmation ARM, not a flag: the two arms are built
 * as distinct object literals so the options discriminated union stays
 * correlated.
 */
function rowsOptions(
  mutate: (n: number) => Promise<MutateResult>,
  contentBased: boolean,
): OptimisticOptions<number[], number> {
  return contentBased
    ? { apply, mutate, isConfirmedBy, sameTarget }
    : { apply, mutate };
}

function useRows(
  mutate: (n: number) => Promise<MutateResult>,
  contentBased: boolean,
  value: NumbersValue = rowsValue,
) {
  return useOptimisticResource(value, rowsOptions(mutate, contentBased));
}

/**
 * Mount one optimistic reader and land its base (`[]` unless given), so the
 * case starts on the settled arm: a read has no placeholder, so `dispatch`
 * exists only once a real value has landed. `rows()` is that arm — a base never
 * leaves again for the same tuple, so it stays readable for the whole case.
 */
async function mountRows(
  live: LiveStateHarness,
  mutate: (n: number) => Promise<MutateResult>,
  {
    contentBased = false,
    value = rowsValue,
  }: { contentBased?: boolean; value?: NumbersValue } = {},
) {
  const rendered = mountPositional(live, () =>
    useRows(mutate, contentBased, value),
  );
  act(() => {
    live.queryClient.setQueryData(queryKeyFor(value.key, undefined), []);
  });
  await settledOf(rendered.result);
  return { ...rendered, rows: () => settledArm(rendered.result.current) };
}

afterEach(() => {
  optimisticDivergenceReportSink.register(null);
  optimisticRejectionSink.register(null);
});

describe("useOptimisticResource", () => {
  it("content-based: a push that lands BEFORE the response still confirms the op", async () => {
    const live = createLiveStateHarness();
    const client = live.queryClient;
    const { mutate, release } = deferredMutate();
    const { rows } = await mountRows(live, mutate, { contentBased: true });

    act(() => {
      rows().dispatch(2);
    });
    expect(rows().saving).toBe(true);
    expect(rows().pendingOps).toHaveLength(1);

    // The confirming push arrives first (the measured production ordering). The
    // op is still unresolved, so the push edge must NOT drop it.
    act(() => {
      client.setQueryData(rowsKey, [1, 2]);
    });
    expect(rows().pendingOps).toHaveLength(1);
    expect(rows().saving).toBe(true);

    // The HTTP response lands 1ms later. The resolve edge re-asks the cache.
    await act(async () => {
      release();
    });
    await waitFor(() => expect(rows().saving).toBe(false));
    expect(rows().pendingOps).toEqual([]);
  });

  it("coarse: the dispatch-time generation stamp confirms at the resolve edge", async () => {
    const live = createLiveStateHarness();
    const client = live.queryClient;
    const { mutate, release } = deferredMutate();
    const { rows } = await mountRows(live, mutate); // no isConfirmedBy ⇒ coarse

    act(() => {
      rows().dispatch(2);
    });
    // A push lands while the mutate is still in flight ⇒ dataUpdateCount bumps
    // past the op's dispatchGen.
    act(() => {
      client.setQueryData(rowsKey, [1, 2]);
    });
    expect(rows().pendingOps).toHaveLength(1);

    await act(async () => {
      release();
    });
    await waitFor(() => expect(rows().pendingOps).toEqual([]));
    expect(rows().saving).toBe(false);
  });

  it("coarse: with no push since dispatch, the op stays until the next push", async () => {
    const live = createLiveStateHarness();
    const client = live.queryClient;
    const { mutate, release } = deferredMutate();
    const { rows } = await mountRows(live, mutate);

    act(() => {
      rows().dispatch(2);
    });
    await act(async () => {
      release();
    });
    // Resolved but unconfirmed: no push has landed since dispatch (the base
    // landed before it, so it does not count).
    await waitFor(() => expect(rows().saving).toBe(false));
    expect(rows().pendingOps).toHaveLength(1);

    act(() => {
      client.setQueryData(rowsKey, [1, 2]);
    });
    expect(rows().pendingOps).toEqual([]);
  });

  it("a cache 'updated' event that carries NO new value confirms nothing", async () => {
    // query-core emits `type: "updated"` for every state action (fetch, error,
    // invalidate, setState) with `state.data` untouched; only `success` bumps
    // `dataUpdateCount`. Coarse mode drops any resolved op on a push, so an
    // ungated subscription would let a bare invalidate — which delivers no
    // server data at all — confirm the op.
    const live = createLiveStateHarness();
    const client = live.queryClient;
    const { mutate, release } = deferredMutate();
    const { rows } = await mountRows(live, mutate);

    act(() => {
      rows().dispatch(2);
    });
    await act(async () => {
      release();
    });
    await waitFor(() => expect(rows().saving).toBe(false));
    expect(rows().pendingOps).toHaveLength(1); // resolved, unconfirmed

    await act(async () => {
      // `refetchType: "none"` keeps this a pure `invalidate` action — no queryFn,
      // no value, but it DOES notify the cache.
      await client.invalidateQueries({
        queryKey: rowsKey,
        refetchType: "none",
      });
    });
    expect(rows().pendingOps).toHaveLength(1); // still unconfirmed

    // ...and a real push still confirms it.
    act(() => {
      client.setQueryData(rowsKey, [1, 2]);
    });
    expect(rows().pendingOps).toEqual([]);
  });

  it("stamps `savedAt`, so the universal indicator leaves `idle` for `saved`", async () => {
    // `savedAt` is private to the hook (it is handed to `useReportSync`), so the
    // observable is the indicator itself: it renders NOTHING while `idle`, and
    // the only way out of `idle` here is an explicit `savedAt` stamp — the
    // spinner is suppressed by its 120ms show-delay, and nothing failed.
    const live = createLiveStateHarness();
    const client = live.queryClient;
    const { mutate, release } = deferredMutate();
    // Published from an EFFECT, never during render: reassigning an outer
    // binding while rendering is a side effect (react-compiler rejects it), and
    // `dispatch` is only ever called from `act()` after the mount has committed.
    const handle: { dispatch?: (n: number) => string } = {};

    function Probe() {
      const rows = useRows(mutate, true);
      // Only the settled arm can dispatch — published once the base lands.
      const dispatch = rows.status !== "ready" ? undefined : rows.dispatch;
      useEffect(() => {
        handle.dispatch = dispatch;
      }, [dispatch]);
      return null;
    }

    const { container } = render(
      <live.Wrapper>
        <SyncStatusProvider>
          <Probe />
          <SyncStatusIndicator />
        </SyncStatusProvider>
      </live.Wrapper>,
    );
    markTransportReady(live);
    act(() => {
      client.setQueryData(rowsKey, []);
    });
    await waitFor(() => expect(handle.dispatch).toBeDefined());
    expect(container.innerHTML).toBe(""); // idle ⇒ the cloud renders nothing

    act(() => {
      handle.dispatch!(2);
    });
    act(() => {
      client.setQueryData(rowsKey, [1, 2]); // the push, before the response
    });
    await act(async () => {
      release();
    });

    await waitFor(() => expect(container.innerHTML).not.toBe(""));
  });

  it("a transient HTTP failure keeps the op RENDERED and surfaces it in `failed`", async () => {
    // Never-revert: a 5xx says the server failed, not the op — a sync-status
    // state (cloud `error` + Retry), not an undo; the prediction stays.
    const live = createLiveStateHarness();
    const mutate = vi.fn(() =>
      Promise.reject(new EndpointError(503, { message: "busy" })),
    );
    const { rows } = await mountRows(live, mutate);

    await act(async () => {
      rows().dispatch(2);
    });
    await waitFor(() => expect(rows().failed).toHaveLength(1));
    expect(rows().pendingOps).toHaveLength(1); // still rendered
    expect(rows().data).toEqual([2]); // the prediction did not revert
    expect(rows().saving).toBe(true); // failed ⇒ still unresolved
  });

  it("a PERMANENT rejection (4xx) drops the op, reports it once, and tells onError", async () => {
    // A 4xx is a final verdict: the server will never hold this state, so the
    // prediction leaves the overlay (server truth renders) and the rejection is
    // emitted for the toast + report.
    const live = createLiveStateHarness();
    const client = live.queryClient;
    const reports: OptimisticRejectionReport[] = [];
    optimisticRejectionSink.register((r) => {
      reports.push(r);
    });
    const onError = vi.fn();
    const mutate = vi.fn(() =>
      Promise.reject(new EndpointError(400, "destination is outside the page")),
    );
    const { result } = mountPositional(live, () =>
      useOptimisticResource(rowsValue, {
        apply,
        mutate,
        onError,
        label: "Rows",
        describeOp: (n) => `add ${n}`,
      }),
    );
    act(() => {
      client.setQueryData(rowsKey, [1]);
    });
    const rows = () => settledArm(result.current);
    await waitFor(() => expect(rows().data).toEqual([1]));

    let opId = "";
    await act(async () => {
      opId = rows().dispatch(2);
    });
    await waitFor(() => expect(rows().pendingOps).toEqual([]));
    expect(rows().data).toEqual([1]); // server truth, not the rejected prediction
    expect(rows().failed).toEqual([]);
    expect(rows().saving).toBe(false);
    expect(reports).toEqual([
      {
        resourceKey: rowsValue.key,
        params: null,
        label: "Rows",
        status: 400,
        message: "destination is outside the page",
        opSummary: "add 2",
        agentWriteRefused: false,
      },
    ]);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]![2]).toEqual({ opId, rejected: true });
  });

  it.each([401, 408, 429, 500])(
    "HTTP %i is transient: the op stays rendered in `failed`, nothing is reported",
    async (status) => {
      const live = createLiveStateHarness();
      const reports: OptimisticRejectionReport[] = [];
      optimisticRejectionSink.register((r) => {
        reports.push(r);
      });
      const mutate = vi.fn(() => Promise.reject(new EndpointError(status, {})));
      const { rows } = await mountRows(live, mutate);

      await act(async () => {
        rows().dispatch(2);
      });
      await waitFor(() => expect(rows().failed).toHaveLength(1));
      expect(rows().data).toEqual([2]);
      expect(reports).toEqual([]);
    },
  );

  it("a permanently rejected op un-parks the newer op queued behind it", async () => {
    const live = createLiveStateHarness();
    const { mutate, calls, sent } = queuedMutate();
    const { rows } = await mountRows(live, mutate, {
      value: laneRejectValue,
    });

    act(() => {
      rows().dispatch(2);
      rows().dispatch(3);
    });
    await settleQueues();
    await act(async () => {
      calls[0]!.reject(new EndpointError(409, "conflict"));
    });
    await waitFor(() => expect(sent()).toEqual([2, 3]));
    expect(rows().data).toEqual([3]); // 2 rejected and gone, 3 still predicted
    await act(async () => {
      calls[1]!.resolve(undefined);
    });
  });

  it("retry(opId) re-fires a failed op IN PLACE (same opId, same overlay position)", async () => {
    const live = createLiveStateHarness();
    const mutate = vi
      .fn<(n: number) => Promise<MutateResult>>()
      .mockRejectedValueOnce(new EndpointError(500, {}))
      .mockResolvedValue(undefined);
    const { rows } = await mountRows(live, mutate);

    let opId = "";
    await act(async () => {
      opId = rows().dispatch(2);
    });
    await waitFor(() => expect(rows().failed).toHaveLength(1));
    expect(rows().failed[0]!.opId).toBe(opId);

    await act(async () => {
      rows().retry(opId);
    });
    await waitFor(() => expect(rows().failed).toEqual([]));
    // Same op, still in the overlay under its original id, now server-acked.
    expect(rows().pendingOps).toEqual([{ opId, vars: 2 }]);
    expect(rows().saving).toBe(false);
    expect(mutate).toHaveBeenCalledTimes(2);
  });

  it("a network-rejected mutate keeps the op rendered as `syncing`, NOT `failed`", async () => {
    // Offline-is-syncing (the Yjs provider's policy): a fetch-level rejection
    // says nothing about the op, so it is not an error state.
    const live = createLiveStateHarness();
    const mutate = vi.fn(() => Promise.reject(new TypeError("fetch failed")));
    const { rows } = await mountRows(live, mutate);

    await act(async () => {
      rows().dispatch(2);
    });
    await waitFor(() => expect(mutate).toHaveBeenCalledTimes(1));
    expect(rows().pendingOps).toHaveLength(1); // still rendered
    expect(rows().data).toEqual([2]);
    expect(rows().failed).toEqual([]); // network ≠ durable failure
    expect(rows().saving).toBe(true); // ⇒ phase `syncing`
  });

  it("the browser `online` edge auto-retries network-failed ops", async () => {
    const live = createLiveStateHarness();
    const mutate = vi
      .fn<(n: number) => Promise<MutateResult>>()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValue(undefined);
    const { rows } = await mountRows(live, mutate);

    let opId = "";
    await act(async () => {
      opId = rows().dispatch(2);
    });
    await waitFor(() => expect(mutate).toHaveBeenCalledTimes(1));
    expect(rows().saving).toBe(true); // queued, syncing

    // Connectivity returns: the reconnect edge re-fires the queued op in place.
    await act(async () => {
      window.dispatchEvent(new Event("online"));
    });
    await waitFor(() => expect(rows().saving).toBe(false));
    expect(mutate).toHaveBeenCalledTimes(2);
    expect(rows().pendingOps).toEqual([{ opId, vars: 2 }]); // resolved, awaiting push
    expect(rows().failed).toEqual([]);
  });

  it("the reconnect drain retries network-failed ops SEQUENTIALLY in overlay order", async () => {
    // Ordering is load-bearing: structural ops depend on their predecessors'
    // server-side effects (a second split targets the block the first one
    // created). A concurrent replay can land out of order and be durably
    // rejected — the drain must await each op before firing the next.
    const live = createLiveStateHarness();
    const releases: Array<(res?: MutateResult) => void> = [];
    let offline = true;
    const mutate = vi.fn((_n: number) => {
      if (offline) return Promise.reject(new TypeError("fetch failed"));
      return new Promise<MutateResult>((resolve) => {
        releases.push(resolve);
      });
    });
    const { rows } = await mountRows(live, mutate);

    await act(async () => {
      rows().dispatch(2);
      rows().dispatch(3);
    });
    await waitFor(() => expect(mutate).toHaveBeenCalledTimes(2));
    offline = false;

    await act(async () => {
      window.dispatchEvent(new Event("online"));
    });
    // Only the FIRST op re-fired; the second waits on its outcome.
    await waitFor(() => expect(mutate).toHaveBeenCalledTimes(3));
    expect(mutate).toHaveBeenLastCalledWith(2);
    expect(releases).toHaveLength(1);

    await act(async () => {
      releases[0]!(undefined);
    });
    await waitFor(() => expect(mutate).toHaveBeenCalledTimes(4));
    expect(mutate).toHaveBeenLastCalledWith(3);
    await act(async () => {
      releases[1]!(undefined);
    });
    await waitFor(() => expect(rows().saving).toBe(false));
  });

  it("a network re-failure stops the drain; the next edge resumes it", async () => {
    // Transport still down ⇒ every later op would fail the same way — stop
    // instead of hammering; the next reconnect edge re-drains from the top.
    const live = createLiveStateHarness();
    let offline = true;
    const mutate = vi.fn((_n: number) =>
      offline
        ? Promise.reject(new TypeError("fetch failed"))
        : Promise.resolve(undefined as MutateResult),
    );
    const { rows } = await mountRows(live, mutate);

    await act(async () => {
      rows().dispatch(2);
      rows().dispatch(3);
    });
    await waitFor(() => expect(mutate).toHaveBeenCalledTimes(2));

    // A premature edge (still offline): op1 re-fails at network level — op2
    // must NOT be tried.
    await act(async () => {
      window.dispatchEvent(new Event("online"));
    });
    await waitFor(() => expect(mutate).toHaveBeenCalledTimes(3));
    await new Promise((r) => setTimeout(r, 20));
    expect(mutate).toHaveBeenCalledTimes(3);
    expect(mutate).toHaveBeenLastCalledWith(2);
    expect(rows().saving).toBe(true);

    offline = false;
    await act(async () => {
      window.dispatchEvent(new Event("online"));
    });
    await waitFor(() => expect(rows().saving).toBe(false));
    expect(mutate).toHaveBeenCalledTimes(5);
    expect(mutate.mock.calls.slice(3).map((c) => c[0])).toEqual([2, 3]);
  });

  it("HTTP-failed ops are NOT auto-retried on the `online` edge", async () => {
    // The server already answered; a reconnect doesn't change that answer.
    // Only an explicit retry() re-sends.
    const live = createLiveStateHarness();
    const mutate = vi.fn(() => Promise.reject(new EndpointError(503, {})));
    const { rows } = await mountRows(live, mutate);

    await act(async () => {
      rows().dispatch(2);
    });
    await waitFor(() => expect(rows().failed).toHaveLength(1));

    await act(async () => {
      window.dispatchEvent(new Event("online"));
    });
    expect(mutate).toHaveBeenCalledTimes(1); // untouched
    expect(rows().failed).toHaveLength(1);
  });

  it("exact ack: an ackTx that landed BEFORE the response confirms at the resolve edge (no snapshot reflecting the op needed)", async () => {
    // The delta-before-HTTP-response race, closed by the registry: the frame
    // carrying this commit's ackTx was noted before the mutate resolved, so the
    // resolve edge's hasAck probe confirms immediately — even though the only
    // snapshot on this tuple is the pre-dispatch base, which lacks the op.
    const live = createLiveStateHarness();
    const { mutate, release } = deferredMutate();
    const { rows } = await mountRows(live, mutate, {
      contentBased: true,
      value: ackRaceValue,
    });

    act(() => {
      rows().dispatch(2);
    });
    // The ack arrives first (a scoped delta / standalone ack frame noted it).
    act(() => {
      noteResourceTxAcks(ackRaceValue.key, undefined, ["77"]);
    });
    expect(rows().pendingOps).toHaveLength(1); // still unresolved — untouched

    await act(async () => {
      release({ watermark: "77" });
    });
    await waitFor(() => expect(rows().pendingOps).toEqual([]));
    expect(rows().saving).toBe(false);
  });

  it("standalone ack: a registry note with NO cache event confirms a resolved op; sync-status is untouched by the ack edge", async () => {
    const reports: OptimisticDivergenceReport[] = [];
    optimisticDivergenceReportSink.register((r) => {
      reports.push(r);
    });
    const live = createLiveStateHarness();
    const { mutate, release } = deferredMutate();
    const { rows } = await mountRows(live, mutate, {
      contentBased: true,
      value: ackStandaloneValue,
    });

    act(() => {
      rows().dispatch(2);
    });
    await act(async () => {
      release({ watermark: "88" });
    });
    // Resolved with its token; no snapshot since the base, no ack yet — it
    // survives.
    await waitFor(() => expect(rows().saving).toBe(false));
    expect(rows().pendingOps).toHaveLength(1);

    // The standalone ack frame: a no-value-change recompute acked the commit.
    // NO setQueryData fires — the registry subscription is the delivery channel.
    act(() => {
      noteResourceTxAcks(ackStandaloneValue.key, undefined, ["88"]);
    });
    expect(rows().pendingOps).toEqual([]);
    // The ack edge is not a sync-status event: nothing failed, nothing saving,
    // and an ack is a confirmation — never a divergence report.
    expect(rows().saving).toBe(false);
    expect(rows().failed).toEqual([]);
    expect(reports).toEqual([]);
  });

  it("params re-baseline: old-tuple acks cannot confirm the new tuple; the new tuple's snapshot watermark backstops", async () => {
    // The registry is namespaced per (key, paramsKey), and the hook probes it
    // at `paramsRef.current` — so after a params change, an ack noted under the
    // OLD tuple is invisible, and the op converges via Rule B on the NEW
    // tuple's watermark-carrying snapshot instead.
    const live = createLiveStateHarness();
    const client = live.queryClient;
    const { mutate, release } = deferredMutate();
    const { result, rerender } = renderHook(
      ({ p }: { p: { v: string } }) =>
        useOptimisticResource(ackRebaseValue, p, { apply, mutate }),
      { wrapper: live.Wrapper, initialProps: { p: { v: "1" } } },
    );
    markTransportReady(live);
    act(() => {
      client.setQueryData(queryKeyFor(ackRebaseValue.key, { v: "1" }), []);
    });
    await settledOf(result);

    act(() => {
      settledArm(result.current).dispatch(2);
    });
    await act(async () => {
      release({ watermark: "100" });
    });
    await waitFor(() => expect(settledArm(result.current).saving).toBe(false));
    expect(settledArm(result.current).pendingOps).toHaveLength(1); // resolved, unconfirmed

    // Params re-baseline mid-flight: pending until the new tuple's base lands.
    // The overlay keeps its op and replays it on that base.
    rerender({ p: { v: "2" } });
    expect(result.current.status).toBe("loading");
    // The new tuple's base carries no watermark — it proves nothing about the
    // commit, so the (coarse, tokened) op survives it.
    act(() => {
      client.setQueryData(queryKeyFor(ackRebaseValue.key, { v: "2" }), [1]);
    });
    const rebased = await settledOf(result);
    expect(rebased.data).toEqual([1, 2]);
    expect(rebased.pendingOps).toHaveLength(1);

    // The commit's ack lands under the OLD tuple — namespaced away: no confirm.
    act(() => {
      noteResourceTxAcks(ackRebaseValue.key, { v: "1" }, ["100"]);
    });
    expect(settledArm(result.current).pendingOps).toHaveLength(1);

    // The NEW tuple's first watermark-carrying snapshot (its sub-ack) is
    // causally past the commit — the coarse+token Rule B backstop confirms.
    act(() => {
      noteResourceWatermark(ackRebaseValue.key, { v: "2" }, "150");
      client.setQueryData(queryKeyFor(ackRebaseValue.key, { v: "2" }), [1, 2]);
    });
    await waitFor(() =>
      expect(settledArm(result.current).pendingOps).toEqual([]),
    );
  });

  it("causal denial: a snapshot past the ack token that lacks the op drops it as superseded", async () => {
    // The one sanctioned eviction. mutate returns the commit's ack token (Rule
    // A); a later push whose registry watermark is strictly past it (Rule B)
    // still doesn't reflect the op ⇒ superseded by newer server truth. The op
    // leaves the overlay and the sink reports kind "superseded".
    const reports: OptimisticDivergenceReport[] = [];
    optimisticDivergenceReportSink.register((r) => {
      reports.push(r);
    });

    const live = createLiveStateHarness();
    const client = live.queryClient;
    const mutate = vi.fn(() => Promise.resolve({ watermark: "100" }));
    const { rows } = await mountRows(live, mutate, {
      contentBased: true,
      value: denialValue,
    });

    await act(async () => {
      rows().dispatch(2);
    });
    // Resolved with its token; the base carries no watermark, so it survives
    // the resolve edge.
    await waitFor(() => expect(rows().saving).toBe(false));
    expect(rows().pendingOps).toHaveLength(1);

    // The push: registry watermark 150 > ack 100 (seeded exactly where the
    // transport writes it — immediately before the cache write), and the
    // snapshot does NOT contain the op's row ⇒ denied.
    act(() => {
      noteResourceWatermark(denialValue.key, undefined, "150");
      client.setQueryData(denialKey, [1]);
    });
    await waitFor(() => expect(rows().pendingOps).toEqual([]));
    expect(rows().data).toEqual([1]); // rendering newer truth
    expect(reports).toHaveLength(1);
    expect(reports[0]!.kind).toBe("superseded");
    expect(reports[0]!.resourceKey).toBe(denialValue.key);
  });

  it("the send lane serializes DISPATCH: B's mutate waits on A's", async () => {
    // The half the primitive used to enforce on retry only. Ops are an ordered
    // fold, so their writes are an ordered stream — B may depend on A's
    // server-side effect (a second split targets the block the first created).
    const live = createLiveStateHarness();
    const { mutate, calls, sent } = queuedMutate();
    const { rows } = await mountRows(live, mutate, { value: laneOrderValue });

    act(() => {
      rows().dispatch(2);
      rows().dispatch(3);
    });
    // A departs immediately (an idle lane adds no latency); B is queued behind.
    await settleQueues();
    expect(sent()).toEqual([2]);
    // ...and the head-of-line block is invisible: both predictions render.
    expect(rows().data).toEqual([2, 3]);

    await act(async () => {
      calls[0]!.resolve(undefined);
    });
    await waitFor(() => expect(sent()).toEqual([2, 3]));
  });

  it("a durably-rejected send does NOT wedge its successors", async () => {
    // The lane advances on settle — resolve or reject alike. A rejected op is a
    // sync-status state, never a stalled queue.
    const live = createLiveStateHarness();
    const { mutate, calls, sent } = queuedMutate();
    const { rows } = await mountRows(live, mutate, { value: laneWedgeValue });

    act(() => {
      rows().dispatch(2);
      rows().dispatch(3);
    });
    await settleQueues();
    expect(sent()).toEqual([2]);

    await act(async () => {
      calls[0]!.reject(new EndpointError(503, { message: "busy" }));
    });
    await waitFor(() => expect(sent()).toEqual([2, 3]));
    expect(rows().failed.map((f) => f.vars)).toEqual([2]);
    expect(rows().data).toEqual([2, 3]); // never-revert, both still rendered

    await act(async () => {
      calls[1]!.resolve(undefined);
    });
  });

  it("two mounts on the same (resource, params) share ONE lane", async () => {
    // The hole a per-hook ref had: two mounted consumers of one tuple are two
    // writers to ONE server-side entity, and a per-instance chain orders each of
    // them against itself only.
    const live = createLiveStateHarness();
    const client = live.queryClient;
    const { mutate, calls, sent } = queuedMutate();
    const { result } = mountPositional(live, () => ({
      a: useRows(mutate, false, laneSharedValue),
      b: useRows(mutate, false, laneSharedValue),
    }));
    act(() => {
      client.setQueryData(queryKeyFor(laneSharedValue.key, undefined), []);
    });
    await waitFor(() => {
      settledArm(result.current.a);
      settledArm(result.current.b);
    });

    act(() => {
      settledArm(result.current.a).dispatch(2);
    });
    act(() => {
      settledArm(result.current.b).dispatch(3);
    });
    await settleQueues();
    expect(sent()).toEqual([2]); // interleaved in dispatch order, not concurrent

    await act(async () => {
      calls[0]!.resolve(undefined);
    });
    await waitFor(() => expect(sent()).toEqual([2, 3]));
    await act(async () => {
      calls[1]!.resolve(undefined);
    });
  });

  it("enqueueResourceWrite joins the SAME lane as a mounted hook's dispatch", async () => {
    // The overlay-less seam: a write whose surface is unmounted (or whose effect
    // no single tuple's overlay can predict) still has to depart in order. It
    // must resolve the lane key exactly as the hook does — a different
    // derivation would order it against nothing.
    const live = createLiveStateHarness();
    const { mutate, calls, sent } = queuedMutate();
    const { rows } = await mountRows(live, mutate, {
      value: laneDetachedValue,
    });

    act(() => {
      rows().dispatch(2);
    });
    let detachedRan = false;
    void enqueueResourceWrite(laneDetachedValue, undefined, async () => {
      detachedRan = true;
      return Promise.resolve();
    });
    await settleQueues();
    // The hook's op is still in flight, so the detached write has NOT departed.
    expect(sent()).toEqual([2]);
    expect(detachedRan).toBe(false);

    await act(async () => {
      calls[0]!.resolve(undefined);
    });
    await waitFor(() => expect(detachedRan).toBe(true));
  });

  it("an idle lane is reclaimed, so the module-level registry cannot grow unboundedly", async () => {
    const live = createLiveStateHarness();
    const { mutate, release } = deferredMutate();
    const idle = activeSendLaneCount();
    const { rows } = await mountRows(live, mutate, {
      value: laneReclaimValue,
    });

    act(() => {
      rows().dispatch(2);
    });
    expect(activeSendLaneCount()).toBe(idle + 1); // held while a send is unsettled

    await act(async () => {
      release();
    });
    // Nothing unsettled ⇒ no ordering constraint left to hold ⇒ dropped.
    await waitFor(() => expect(activeSendLaneCount()).toBe(idle));
  });
});

// ---------------------------------------------------------------------------
// The read forms: a `liveValue` (plus params) or a collection's `{ ids }` read.
// No placeholder is ever the base: `pending` until a real value lands, and
// `dispatch` exists only on the settled arm.
// ---------------------------------------------------------------------------

const numbersValue = liveValue("test.optimistic-mutation.value", {
  schema: z.array(z.number()),
});
const numbersKey = queryKeyFor(numbersValue.key, undefined);
const namedValue = liveValue("test.optimistic-mutation.named", {
  schema: z.array(z.number()),
  params: ["name"],
});

type RankRow = { id: string; rank: string };
const ranks = liveCollection("test.optimistic-mutation.ranks", {
  carry: { fields: { id: textField(), rank: textField() } },
  id: "id",
  sortable: ["rank"],
  default: { orderBy: [["rank", "asc"]], limit: 50 },
  maxLimit: 200,
});
const setRank = (rows: RankRow[], v: { id: string; rank: string }): RankRow[] =>
  rows.map((r) => (r.id === v.id ? { ...r, rank: v.rank } : r));

describe("useOptimisticResource — read forms", () => {
  it("a value is pending until its first value lands; then dispatch replays and a push confirms", async () => {
    const live = createLiveStateHarness();
    const client = live.queryClient;
    const { mutate, release } = deferredMutate();
    const { result } = mountPositional(live, () =>
      useOptimisticResource(numbersValue, { apply, mutate }),
    );
    expect(result.current.status).toBe("loading");
    expect("dispatch" in result.current).toBe(false);
    expect("data" in result.current).toBe(false);
    // The not-settled arm carries the read's Retry, so a host gating on it can
    // offer one for a failed first load (and it survives into the settled arm).
    const pendingRefetch = result.current.refetch;
    expect(typeof pendingRefetch).toBe("function");

    act(() => {
      client.setQueryData(numbersKey, [1]);
    });
    const settled = await settledOf(result);
    expect(settled.data).toEqual([1]);
    expect(settled.refetch).toBe(pendingRefetch);

    act(() => {
      settled.dispatch(2);
    });
    const withOp = await settledOf(result);
    expect(withOp.data).toEqual([1, 2]);
    expect(withOp.serverData).toEqual([1]);

    act(() => {
      client.setQueryData(numbersKey, [1, 2]); // the push, before the response
    });
    await act(async () => {
      release();
    });
    await waitFor(() => {
      const r = result.current;
      if (r.status !== "ready") throw new Error("expected the settled arm");
      expect(r.pendingOps).toEqual([]);
      expect(r.saving).toBe(false);
    });
  });

  it("the loading arm has no dispatch, data or serverData (type level)", () => {
    const live = createLiveStateHarness();
    const { result } = mountPositional(live, () =>
      useOptimisticResource(numbersValue, { apply, mutate: async () => {} }),
    );
    const r = result.current;
    if (r.status === "loading") {
      // @ts-expect-error — an op cannot be made against a base nobody has seen
      void r.dispatch;
      // @ts-expect-error — no stand-in value while pending
      void r.data;
      // @ts-expect-error — no stand-in base while pending
      void r.serverData;
    }
    expect(r.status).toBe("loading");
  });

  it("a parameterized value reads its own tuple; its params are required (type level)", async () => {
    const live = createLiveStateHarness();
    const client = live.queryClient;
    const { result } = mountPositional(live, () =>
      useOptimisticResource(
        namedValue,
        { name: "a" },
        { apply, mutate: async () => {} },
      ),
    );
    expect(result.current.status).toBe("loading");
    act(() => {
      client.setQueryData(queryKeyFor(namedValue.key, { name: "a" }), [7]);
    });
    expect((await settledOf(result)).data).toEqual([7]);

    // Never called — the assertions are the `@ts-expect-error`s.
    const useTypeOnly = () => {
      // @ts-expect-error — a parameterized value's params are required
      useOptimisticResource(namedValue, { apply, mutate: async () => {} });
      useOptimisticResource(
        numbersValue,
        // @ts-expect-error — apply must fold the value's own type
        { apply: (c: string[]) => c, mutate: async () => {} },
      );
    };
    expect(typeof useTypeOnly).toBe("function");
  });

  it("a collection's { ids } read stays loading until a real value lands on its canonical id set", async () => {
    // No descriptor seeds a value: the `:rows` tuple's cache entry is empty
    // until the server answers, and the read says `loading` — never a `[]`
    // stand-in an op could be folded onto.
    const live = createLiveStateHarness();
    const client = live.queryClient;
    const { result } = mountPositional(live, () =>
      useOptimisticResource(
        ranks,
        { ids: ["b", "a"] },
        { apply: setRank, mutate: async () => {} },
      ),
    );
    expect(result.current.status).toBe("loading");
    expect(
      client.getQueryData(queryKeyFor(ranks.rows.key, { ids: "a,b" })),
    ).toBeUndefined();
    act(() => {
      client.setQueryData(queryKeyFor(ranks.rows.key, { ids: "a,b" }), [
        { id: "a", rank: "m" },
      ]);
    });
    expect((await settledOf(result)).data).toEqual([{ id: "a", rank: "m" }]);
  });

  it("an optimistic reader asks for acks on its tuple, and drops the request on unmount", () => {
    const original = NotificationsClient.prototype.requestAcks;
    const released = vi.fn();
    const requestAcks = vi
      .spyOn(NotificationsClient.prototype, "requestAcks")
      .mockImplementation(function (this: NotificationsClient, ...args) {
        const release = original.apply(this, args);
        return () => {
          released();
          release();
        };
      });
    const live = createLiveStateHarness();
    const { unmount } = mountPositional(live, () =>
      useOptimisticResource(
        ranks,
        { ids: ["a"] },
        { apply: setRank, mutate: async () => {} },
      ),
    );
    expect(requestAcks).toHaveBeenCalledWith(
      ranks.rows.key,
      { ids: "a" },
      undefined,
    );
    expect(released).not.toHaveBeenCalled();
    unmount();
    expect(released).toHaveBeenCalledTimes(1);
    requestAcks.mockRestore();
  });

  it("a reorder whose write changed nothing in the tuple still confirms, via the standalone ack", async () => {
    const live = createLiveStateHarness();
    const client = live.queryClient;
    const { mutate, release } = deferredMutate();
    const params = { ids: "a,b" };
    const { result } = mountPositional(live, () =>
      useOptimisticResource(
        ranks,
        { ids: ["a", "b"] },
        { apply: setRank, mutate },
      ),
    );
    act(() => {
      client.setQueryData(queryKeyFor(ranks.rows.key, params), [
        { id: "a", rank: "a" },
        { id: "b", rank: "b" },
      ]);
    });
    const settled = await settledOf(result);
    act(() => {
      settled.dispatch({ id: "a", rank: "c" });
    });
    await act(async () => {
      release({ watermark: "4242" });
    });
    await waitFor(() => {
      const r = result.current;
      if (r.status !== "ready") throw new Error("expected the settled arm");
      expect(r.saving).toBe(false);
      expect(r.pendingOps).toHaveLength(1); // resolved; no push, no ack yet
    });

    // The write landed outside what this tuple can see (net-zero here): the
    // server sends a standalone ack, which produces no cache event at all.
    act(() => {
      noteResourceTxAcks(ranks.rows.key, params, ["4242"]);
    });
    expect((await settledOf(result)).pendingOps).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The scoped form: one scope of a collection declared `all: { by }`, read
// `{ where }`. The base is that scope's rows IN ORDER; a scoped delta (no
// watermark, Rule B′) is merged into it by key; an op confirms by its exact
// ack or by content, and only a full frame's watermark may deny it.
// ---------------------------------------------------------------------------

type BlockRow = { id: string; pageId: string; rank: string; text: string };
const scopedBlocks = liveCollection("test.optimistic-mutation.scoped", {
  carry: {
    fields: {
      id: textField(),
      pageId: textField(),
      rank: textField(),
      text: textField(),
    },
  },
  id: "id",
  all: {
    by: ["pageId"],
    orderBy: [["rank", "asc"]],
    unbounded: { reason: "one page's blocks" },
  },
});
// A second scoped key, for the lane case: the send lanes are module-level.
const scopedLane = liveCollection("test.optimistic-mutation.scoped-lane", {
  carry: { fields: { id: textField(), pageId: textField() } },
  id: "id",
  all: {
    by: ["pageId"],
    orderBy: [["id", "asc"]],
    unbounded: { reason: "one page's blocks" },
  },
});
const blockKeyOf = (row: unknown): string => (row as BlockRow).id;
const setText = (
  rows: BlockRow[],
  v: { id: string; text: string },
): BlockRow[] => rows.map((r) => (r.id === v.id ? { ...r, text: v.text } : r));
const textReflected = (
  rows: BlockRow[],
  v: { id: string; text: string },
): boolean => rows.some((r) => r.id === v.id && r.text === v.text);
const sameBlock = (a: { id: string }, b: { id: string }): boolean =>
  a.id === b.id;

describe("useOptimisticResource — a scoped `all` set ({ where })", () => {
  const block = (id: string, rank: string, text: string): BlockRow => ({
    id,
    pageId: "p1",
    rank,
    text,
  });

  /** A scoped `delta` frame as the client writes it: acks noted, then the merge (no watermark). */
  function deliverDelta(
    live: LiveStateHarness,
    params: Record<string, string>,
    upserts: BlockRow[],
    ackTx: string[] = [],
  ): void {
    const qk = queryKeyFor(scopedBlocks.key, params);
    const prev = live.queryClient.getQueryData<BlockRow[]>(qk) ?? [];
    const merged = mergeKeyedDelta(
      prev,
      new Map(upserts.map((r) => [r.id, r])),
      undefined,
      blockKeyOf,
    );
    if (merged.kind !== "merged") throw new Error("the delta drifted");
    act(() => {
      if (ackTx.length > 0) noteResourceTxAcks(scopedBlocks.key, params, ackTx);
      live.queryClient.setQueryData(qk, merged.rows);
    });
  }

  it("reads the scope's tuple in order; watermark-less deltas merge by key and confirm the op by its exact ack, never deny it", async () => {
    const live = createLiveStateHarness();
    const client = live.queryClient;
    const { mutate, release } = deferredMutate();
    const params = { pageId: "p1" };
    const reports: OptimisticDivergenceReport[] = [];
    optimisticDivergenceReportSink.register((r) => {
      reports.push(r);
    });
    const { result } = mountPositional(live, () =>
      useOptimisticResource(
        scopedBlocks,
        { where: { pageId: "p1" } },
        {
          apply: setText,
          mutate: mutate as (v: {
            id: string;
            text: string;
          }) => Promise<MutateResult>,
          isConfirmedBy: textReflected,
          sameTarget: sameBlock,
        },
      ),
    );
    // Not known yet: the scope's tuple holds nothing.
    expect(result.current.status).toBe("loading");
    // The sub-ack — a FULL frame, so it carries the snapshot watermark.
    act(() => {
      noteResourceWatermark(scopedBlocks.key, params, "100");
      client.setQueryData(queryKeyFor(scopedBlocks.key, params), [
        block("a", "a0", "A"),
        block("b", "a1", "B"),
      ]);
    });
    const settled = await settledOf(result);
    act(() => {
      settled.dispatch({ id: "b", text: "typed" });
    });
    await act(async () => {
      release({ watermark: "150" });
    });
    await waitFor(() => expect(settledArm(result.current).saving).toBe(false));

    // Another block's typing projection: a scoped delta, no watermark. The
    // registry still holds the full frame's "100" — not past the op's "150",
    // so the unreflected snapshot denies nothing: the op stays, in order.
    deliverDelta(live, params, [block("a", "a0", "A2")]);
    const kept = settledArm(result.current);
    expect(kept.pendingOps).toHaveLength(1);
    expect(kept.serverData.map((r) => r.text)).toEqual(["A2", "B"]);
    expect(kept.data.map((r) => `${r.id}:${r.text}`)).toEqual([
      "a:A2",
      "b:typed",
    ]);

    // The op's own commit, re-read: a scoped delta carrying its ackTx and the
    // row — confirmed exactly, with no watermark anywhere.
    deliverDelta(live, params, [block("b", "a1", "typed")], ["150"]);
    await waitFor(() =>
      expect(settledArm(result.current).pendingOps).toEqual([]),
    );
    expect(settledArm(result.current).data.map((r) => r.text)).toEqual([
      "A2",
      "typed",
    ]);
    expect(reports).toEqual([]);
  });

  it("an ack on a delta that does NOT reflect the op still confirms it (a later write won); only a full frame's watermark denies", async () => {
    const live = createLiveStateHarness();
    const client = live.queryClient;
    const params = { pageId: "p2" };
    const { mutate, release } = deferredMutate();
    const mutateText = mutate as (v: {
      id: string;
      text: string;
    }) => Promise<MutateResult>;
    const reports: OptimisticDivergenceReport[] = [];
    optimisticDivergenceReportSink.register((r) => {
      reports.push(r);
    });
    const { result } = mountPositional(live, () =>
      useOptimisticResource(
        scopedBlocks,
        { where: { pageId: "p2" } },
        {
          apply: setText,
          mutate: mutateText,
          isConfirmedBy: textReflected,
          sameTarget: sameBlock,
        },
      ),
    );
    act(() => {
      noteResourceWatermark(scopedBlocks.key, params, "200");
      client.setQueryData(queryKeyFor(scopedBlocks.key, params), [
        { ...block("x", "a0", "X"), pageId: "p2" },
      ]);
    });
    const settled = await settledOf(result);

    // Op 1: acked by a delta whose row a newer writer already overwrote.
    act(() => {
      settled.dispatch({ id: "x", text: "mine" });
    });
    await act(async () => {
      release({ watermark: "250" });
    });
    deliverDelta(
      live,
      params,
      [{ ...block("x", "a0", "theirs"), pageId: "p2" }],
      ["250"],
    );
    await waitFor(() =>
      expect(settledArm(result.current).pendingOps).toEqual([]),
    );
    // An ack confirms; it never denies — no divergence report.
    expect(reports).toEqual([]);

    // Op 2: no ack arrives; a FULL frame (a FULL reload — `order` and the
    // snapshot watermark) causally past its commit lacks its effect: denied.
    act(() => {
      settledArm(result.current).dispatch({ id: "x", text: "again" });
    });
    await act(async () => {
      release({ watermark: "300" });
    });
    act(() => {
      noteResourceWatermark(scopedBlocks.key, params, "301");
      client.setQueryData(queryKeyFor(scopedBlocks.key, params), [
        { ...block("x", "a0", "newest"), pageId: "p2" },
      ]);
    });
    await waitFor(() =>
      expect(settledArm(result.current).pendingOps).toEqual([]),
    );
    expect(reports.map((r) => r.kind)).toEqual(["superseded"]);
  });

  it("enqueueDetachedWrite and enqueueResourceWrite name the SAME lane as the mounted scope's dispatch", async () => {
    const live = createLiveStateHarness();
    const client = live.queryClient;
    const calls: Array<() => void> = [];
    const mutate = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          calls.push(resolve);
        }),
    );
    const { result } = mountPositional(live, () =>
      useOptimisticResource(
        scopedLane,
        { where: { pageId: "p1" } },
        { apply: (rows: { id: string; pageId: string }[]) => rows, mutate },
      ),
    );
    act(() => {
      client.setQueryData(queryKeyFor(scopedLane.key, { pageId: "p1" }), []);
    });
    const settled = await settledOf(result);
    act(() => {
      settled.dispatch(undefined);
    });
    const ran: string[] = [];
    enqueueDetachedWrite(
      scopedLane,
      { where: { pageId: "p1" } },
      { label: "Page", describe: "move" },
      async () => {
        ran.push("detached");
      },
    );
    void enqueueResourceWrite(
      scopedLane,
      { where: { pageId: "p1" } },
      async () => {
        ran.push("write");
      },
    );
    // Another scope is another lane: it departs at once.
    void enqueueResourceWrite(
      scopedLane,
      { where: { pageId: "p2" } },
      async () => {
        ran.push("other page");
      },
    );
    await settleQueues();
    expect(ran).toEqual(["other page"]);
    await act(async () => {
      calls[0]!();
    });
    await waitFor(() =>
      expect(ran).toEqual(["other page", "detached", "write"]),
    );
  });

  it("a scope that is not exactly the `by` fields throws at the call site; `{ where }` on a set without `by` too", () => {
    const untyped = (q: unknown) => () =>
      enqueueResourceWrite(
        scopedLane,
        q as { where: { pageId: string } },
        async () => {},
      );
    expect(untyped({ where: {} })).toThrow(/pageId/);
    expect(untyped({ where: { pageId: "p", x: "1" } })).toThrow(
      /unknown param/,
    );
    expect(untyped({ where: { pageId: "" } })).toThrow(/non-empty string/);
    const whole = liveCollection("test.optimistic-mutation.whole", {
      carry: { fields: { id: textField() } },
      id: "id",
      all: { orderBy: [["id", "asc"]], unbounded: { reason: "test" } },
    });
    expect(() =>
      enqueueResourceWrite(
        whole as unknown as typeof scopedLane,
        { where: { pageId: "p" } },
        async () => {},
      ),
    ).toThrow(/not declared `all: \{ by \}`/);
  });

  it("the scope's types: exactly the `by` fields; no `{ where }` on a set without `by` (type level)", () => {
    const whole = liveCollection("test.optimistic-mutation.whole-types", {
      carry: { fields: { id: textField() } },
      id: "id",
      all: { orderBy: [["id", "asc"]], unbounded: { reason: "test" } },
    });
    const opts = {
      apply: (rows: BlockRow[]) => rows,
      mutate: async () => {},
    };
    const useTypeOnly = () => {
      useOptimisticResource(scopedBlocks, { where: { pageId: "p" } }, opts);
      // @ts-expect-error — a scope names exactly the `by` fields
      useOptimisticResource(scopedBlocks, { where: { id: "p" } }, opts);
      // @ts-expect-error — no extra field beside the scope
      useOptimisticResource(
        scopedBlocks,
        { where: { pageId: "p", text: "t" } },
        opts,
      );
      // @ts-expect-error — a set declared without `by` has no scope
      useOptimisticResource(
        whole,
        { where: { pageId: "p" } },
        {
          apply: (rows: { id: string }[]) => rows,
          mutate: async () => {},
        },
      );
      // @ts-expect-error — the detached form takes the same scope
      enqueueDetachedWrite(
        scopedBlocks,
        { pageId: "p" },
        { label: "Page", describe: "move" },
        async () => {},
      );
    };
    expect(typeof useTypeOnly).toBe("function");
  });
});

describe("useOptimisticResource — confirm latency samples", () => {
  // Every case reads a key of its own (the tx-ack registry is module-level).
  const latencyValue = (name: string) =>
    liveValue(`test.optimistic-mutation.latency-${name}`, { schema: Numbers });

  // The op stamps' clock, driven by hand: phases are then exact differences,
  // and nothing depends on how long the test really took.
  let clock = 0;
  let samples: ClientLatencySample[] = [];
  let unsubscribe: () => void = () => {};
  beforeEach(() => {
    clock = 0;
    samples = [];
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    unsubscribe = clientLatencySink.subscribe((s) => {
      samples.push(s);
    });
  });
  afterEach(() => {
    unsubscribe();
    vi.restoreAllMocks();
  });

  it("push edge: the confirming snapshot lands after the response", async () => {
    const value = latencyValue("push");
    const live = createLiveStateHarness();
    const { mutate, release } = deferredMutate();
    const { rows } = await mountRows(live, mutate, {
      contentBased: true,
      value,
    });

    clock = 100;
    act(() => {
      rows().dispatch(2); // an idle lane sends at once
    });
    clock = 150;
    await act(async () => {
      release();
    });
    await waitFor(() => expect(rows().saving).toBe(false));
    expect(samples).toEqual([]); // resolved, not yet confirmed

    clock = 180;
    act(() => {
      live.queryClient.setQueryData(queryKeyFor(value.key, undefined), [2]);
    });
    expect(samples).toEqual([
      {
        signal: "confirm",
        key: value.key,
        params: {},
        variant: "content/push",
        phases: {
          "send-lane": 0,
          retry: 0,
          "server-ack": 50,
          "confirm-frame": 30,
        },
        totalMs: 80,
        hidden: false,
      },
    ]);
  });

  it("resolve edge: the confirming snapshot beat the response, so confirm-frame is 0", async () => {
    const value = latencyValue("resolve");
    const live = createLiveStateHarness();
    const { mutate, release } = deferredMutate();
    const { rows } = await mountRows(live, mutate, {
      contentBased: true,
      value,
    });

    clock = 100;
    act(() => {
      rows().dispatch(2);
    });
    clock = 120;
    act(() => {
      live.queryClient.setQueryData(queryKeyFor(value.key, undefined), [2]);
    });
    expect(samples).toEqual([]); // unresolved — the push edge keeps it
    clock = 150;
    await act(async () => {
      release();
    });
    await waitFor(() => expect(samples).toHaveLength(1));
    expect(samples[0]).toMatchObject({
      variant: "content/resolve",
      phases: { "server-ack": 50, "confirm-frame": 0 },
      totalMs: 50,
    });
  });

  it("ack edge: a standalone ack frame confirms the op exactly", async () => {
    const value = latencyValue("ack");
    const live = createLiveStateHarness();
    const { mutate, release } = deferredMutate();
    const { rows } = await mountRows(live, mutate, { value }); // coarse

    clock = 100;
    act(() => {
      rows().dispatch(2);
    });
    clock = 140;
    await act(async () => {
      release({ watermark: "555" });
    });
    await waitFor(() => expect(rows().saving).toBe(false));
    expect(samples).toEqual([]);

    clock = 200;
    act(() => {
      noteResourceTxAcks(value.key, undefined, ["555"]);
    });
    expect(samples).toHaveLength(1);
    expect(samples[0]).toMatchObject({
      variant: "exact-ack/ack",
      phases: { "server-ack": 40, "confirm-frame": 60 },
      totalMs: 100,
    });
  });

  it("a retry through the reconnect drain lands in the retry phase", async () => {
    const value = latencyValue("retry");
    const live = createLiveStateHarness();
    const mutate = vi
      .fn<(n: number) => Promise<MutateResult>>()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValue(undefined);
    const { rows } = await mountRows(live, mutate, { value });

    clock = 100;
    await act(async () => {
      rows().dispatch(2);
    });
    await waitFor(() => expect(mutate).toHaveBeenCalledTimes(1));
    clock = 300;
    await act(async () => {
      window.dispatchEvent(new Event("online"));
    });
    await waitFor(() => expect(rows().saving).toBe(false));
    expect(mutate).toHaveBeenCalledTimes(2);

    clock = 360;
    act(() => {
      live.queryClient.setQueryData(queryKeyFor(value.key, undefined), [2]);
    });
    expect(samples).toHaveLength(1);
    expect(samples[0]).toMatchObject({
      variant: "tokenless/push",
      phases: {
        "send-lane": 0,
        retry: 200,
        "server-ack": 0,
        "confirm-frame": 60,
      },
      totalMs: 260,
    });
  });

  it("a queued op's send-lane phase is its wait behind the op ahead of it", async () => {
    const value = latencyValue("queued");
    const live = createLiveStateHarness();
    const { mutate, calls } = queuedMutate();
    const { rows } = await mountRows(live, mutate, {
      contentBased: true,
      value,
    });

    clock = 100;
    act(() => {
      rows().dispatch(2);
      rows().dispatch(3);
    });
    await settleQueues();
    clock = 200;
    await act(async () => {
      calls[0]!.resolve(undefined); // the second op departs now
    });
    await waitFor(() => expect(calls).toHaveLength(2));
    clock = 260;
    await act(async () => {
      calls[1]!.resolve(undefined);
    });
    await waitFor(() => expect(rows().saving).toBe(false));

    clock = 300;
    act(() => {
      live.queryClient.setQueryData(queryKeyFor(value.key, undefined), [2, 3]);
    });
    expect(samples.map((s) => s.phases)).toEqual([
      { "send-lane": 0, retry: 0, "server-ack": 100, "confirm-frame": 100 },
      { "send-lane": 100, retry: 0, "server-ack": 60, "confirm-frame": 40 },
    ]);
  });

  it("a rejected op emits nothing", async () => {
    const value = latencyValue("rejected");
    const live = createLiveStateHarness();
    const mutate = vi.fn(() => Promise.reject(new EndpointError(400, "nope")));
    const { rows } = await mountRows(live, mutate, { value });

    await act(async () => {
      rows().dispatch(2);
    });
    await waitFor(() => expect(rows().pendingOps).toEqual([]));
    act(() => {
      live.queryClient.setQueryData(queryKeyFor(value.key, undefined), [2]);
    });
    expect(samples).toEqual([]);
  });

  // Last: the visibility stamp is page-global, so it would tag any later op
  // dispatched before it.
  it("an op the tab was hidden during is tagged hidden", async () => {
    const value = latencyValue("hidden");
    const live = createLiveStateHarness();
    const { mutate, release } = deferredMutate();
    const { rows } = await mountRows(live, mutate, {
      contentBased: true,
      value,
    });

    clock = 1_000_000;
    act(() => {
      rows().dispatch(2);
    });
    clock = 1_000_010;
    document.dispatchEvent(new Event("visibilitychange")); // hidden, then back
    clock = 1_000_020;
    await act(async () => {
      release();
    });
    clock = 1_000_030;
    act(() => {
      live.queryClient.setQueryData(queryKeyFor(value.key, undefined), [2]);
    });
    expect(samples).toHaveLength(1);
    expect(samples[0]!.hidden).toBe(true);
  });
});
