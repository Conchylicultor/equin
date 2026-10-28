/**
 * Predicted writes end to end over a `createLiveStateHarness` and a fake
 * endpoint fetcher: `useLiveMutation(endpoint).mutate` shows the endpoint's
 * declared `effect` at once in `useLiveRow` and in a list (a membership exit
 * hides the row), per-tuple retirement keeps it hidden in a stale list after
 * the by-id tuple confirmed, a permanent 4xx removes the prediction and is
 * emitted as a rejection, a network error keeps it, and the `confirm` signal
 * gets its complete sample at done and its censored one at the deadline.
 * A read no prediction touches keeps its data's identity.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@plugins/primitives/plugins/log-channels/web", () => ({
  clientLog: () => {},
}));

import { act, renderHook, waitFor } from "@testing-library/react";
import { nullable } from "@plugins/fields/core";
import {
  enumTextField,
  textField,
} from "@plugins/fields/plugins/text/plugins/config/core";
import {
  defineEndpoint,
  EndpointError,
} from "@plugins/infra/plugins/endpoints/core";
import { entityRef } from "@plugins/infra/plugins/entities/core";
import { fakeFetchEndpoint } from "@plugins/infra/plugins/endpoints/web/testing";
import { liveCollection, patchRow } from "@plugins/network/plugins/live/core";
import {
  optimisticRejectionSink,
  useLive,
  useLiveMutation,
  useLiveRow,
} from "@plugins/network/plugins/live/web";
import type { OptimisticRejectionReport } from "@plugins/network/plugins/live/web/testing";
import {
  queryKeyFor,
  type ResourceResult,
} from "@plugins/primitives/plugins/live-state/web";
import { createLiveStateHarness } from "@plugins/primitives/plugins/live-state/web/testing";
import {
  clientLatencySink,
  type ClientLatencySample,
} from "@plugins/primitives/plugins/perfs/plugins/latency-signal/core";

let seq = 0;

function world(confirmWithinMs?: number) {
  const n = seq++;
  const convs = entityRef(`pw_convs_${n}`, {
    id: textField(),
    status: enumTextField(["working", "done"] as const, { label: "Status" }),
    workingOn: nullable(textField({ label: "Working on" })),
  });
  const byId = liveCollection(`pw.by-id.${n}`, {
    from: convs,
    carry: { pick: ["id", "status", "workingOn"] },
    id: "id",
  });
  const active = liveCollection(`pw.active.${n}`, {
    from: convs,
    pick: ["status"],
    carry: { pick: ["id", "workingOn"] },
    id: "id",
    membership: { column: "status", op: "ne", operand: "done" } as const,
    all: { orderBy: [["id", "asc"]], unbounded: { reason: "a test set" } },
  });
  const exit = defineEndpoint({
    route: `POST /api/pw${n}/:id/exit`,
    effect: (on) =>
      patchRow(
        on,
        convs,
        ({ params }) => params.id,
        () => ({ set: { status: "done", workingOn: null } }),
        confirmWithinMs === undefined ? undefined : { confirmWithinMs },
      ),
  });
  return { byId, active, exit };
}

type Row = { id: string; status: "working" | "done"; workingOn: string | null };
const working = (id: string): Row => ({
  id,
  status: "working",
  workingOn: "x",
});
const done = (id: string): Row => ({ id, status: "done", workingOn: null });

/** A fetch answer the test settles by hand. */
function deferred() {
  let resolve!: (v: unknown) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<unknown>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function setup(w: ReturnType<typeof world>, answer: () => Promise<unknown>) {
  const fake = fakeFetchEndpoint(() => answer());
  const live = createLiveStateHarness({ transport: fake.transport });
  const byIdKey = queryKeyFor(w.byId.rows.key, { ids: "a" });
  const activeKey = queryKeyFor(w.active.key, undefined);
  live.queryClient.setQueryData(byIdKey, [working("a")]);
  live.queryClient.setQueryData(activeKey, [working("a"), working("b")]);
  const onSuccess = vi.fn();
  const onError = vi.fn();
  const hook = renderHook(
    () => ({
      row: useLiveRow(w.byId, "a"),
      list: useLive(w.active) as ResourceResult<Row[]>,
      write: useLiveMutation(w.exit, { onSuccess, onError }),
    }),
    { wrapper: live.Wrapper },
  );
  const push = (key: unknown[], rows: Row[]) =>
    act(() => {
      live.queryClient.setQueryData(key, rows);
    });
  return { fake, live, hook, byIdKey, activeKey, push, onSuccess, onError };
}

const ids = (r: ResourceResult<Row[]>): string[] => {
  if (r.status !== "ready") throw new Error(`expected ready, got ${r.status}`);
  return r.data.map((x) => x.id);
};

describe("useLiveMutation — predicted writes", () => {
  let samples: ClientLatencySample[];
  let rejections: OptimisticRejectionReport[];
  let off: () => void;
  beforeEach(() => {
    samples = [];
    rejections = [];
    off = clientLatencySink.subscribe((s) => samples.push(s));
    optimisticRejectionSink.register((r) => rejections.push(r));
  });
  afterEach(() => {
    off();
    optimisticRejectionSink.register(null);
    vi.useRealTimers();
  });

  it("a read no prediction touches keeps its data's identity", async () => {
    const w = world();
    const s = setup(w, () => Promise.resolve(undefined));
    await waitFor(() =>
      expect(s.hook.result.current.list.status).toBe("ready"),
    );
    const list = s.hook.result.current.list;
    expect(list.status === "ready" && list.data).toBe(
      s.live.queryClient.getQueryData(s.activeKey),
    );
    expect(s.hook.result.current.row).toMatchObject({
      status: "ready",
      found: true,
      pending: false,
    });
  });

  it("shows the effect at once — patched by id, gone from the list — before the server answers", async () => {
    const w = world();
    const answer = deferred();
    const s = setup(w, () => answer.promise);
    await waitFor(() =>
      expect(s.hook.result.current.list.status).toBe("ready"),
    );
    const { write } = s.hook.result.current;
    expect(write.kind).toBe("available");
    // No pending state, no promise: `mutate` returns nothing.
    expect(Object.keys(write).sort()).toEqual(["kind", "mutate"]);

    act(() => {
      write.mutate({ params: { id: "a" } });
    });
    const { row, list } = s.hook.result.current;
    expect(row).toMatchObject({
      status: "ready",
      found: true,
      pending: true,
      row: done("a"),
    });
    expect(ids(list)).toEqual(["b"]);
    await waitFor(() => expect(s.fake.calls).toHaveLength(1));
    expect(s.fake.calls[0]!.params).toEqual({ id: "a" });
    expect(s.onSuccess).not.toHaveBeenCalled();
  });

  it("retires per tuple: by-id confirms first, the stale list keeps the row hidden until its own frame", async () => {
    const w = world();
    const answer = deferred();
    const s = setup(w, () => answer.promise);
    await waitFor(() =>
      expect(s.hook.result.current.list.status).toBe("ready"),
    );
    act(() => {
      s.hook.result.current.write.mutate({ params: { id: "a" } });
    });
    await act(async () => {
      answer.resolve(undefined);
      await answer.promise;
    });
    expect(s.onSuccess).toHaveBeenCalledTimes(1);

    // The by-id frame lands first: confirmed there (not pending any more).
    s.push(s.byIdKey, [done("a")]);
    await waitFor(() =>
      expect(s.hook.result.current.row).toMatchObject({ pending: false }),
    );
    // The active list's server data is still the stale row: still hidden.
    expect(ids(s.hook.result.current.list)).toEqual(["b"]);
    expect(samples.filter((x) => x.signal === "confirm")).toEqual([]);

    // Its own frame drops it: the op is done, and its sample filed.
    s.push(s.activeKey, [working("b")]);
    await waitFor(() =>
      expect(samples.filter((x) => x.signal === "confirm")).toHaveLength(1),
    );
    expect(ids(s.hook.result.current.list)).toEqual(["b"]);
    const sample = samples[0]!;
    expect(sample).toMatchObject({
      signal: "confirm",
      variant: `predict/${w.exit.route}`,
      key: w.exit.route,
      params: { id: "a" },
    });
    expect("censored" in sample && sample.censored).toBeFalsy();
  });

  it("a permanent 4xx removes the prediction and emits a rejection", async () => {
    const w = world();
    const answer = deferred();
    const s = setup(w, () => answer.promise);
    await waitFor(() =>
      expect(s.hook.result.current.list.status).toBe("ready"),
    );
    act(() => {
      s.hook.result.current.write.mutate({ params: { id: "a" } });
    });
    expect(ids(s.hook.result.current.list)).toEqual(["b"]);
    await act(async () => {
      answer.reject(new EndpointError(409, "already closed"));
      await expect(answer.promise).rejects.toBeInstanceOf(EndpointError);
    });
    await waitFor(() =>
      expect(ids(s.hook.result.current.list)).toEqual(["a", "b"]),
    );
    expect(s.hook.result.current.row).toMatchObject({
      found: true,
      pending: false,
      row: working("a"),
    });
    expect(rejections).toHaveLength(1);
    expect(rejections[0]).toMatchObject({
      resourceKey: w.exit.route,
      status: 409,
      message: "already closed",
    });
    expect(s.onError).toHaveBeenCalledTimes(1);
    expect(s.onError.mock.calls[0]![2]).toEqual({ rejected: true });
  });

  it("a network error keeps the prediction (never-revert)", async () => {
    const w = world();
    const answer = deferred();
    const s = setup(w, () => answer.promise);
    await waitFor(() =>
      expect(s.hook.result.current.list.status).toBe("ready"),
    );
    act(() => {
      s.hook.result.current.write.mutate({ params: { id: "a" } });
    });
    await act(async () => {
      answer.reject(new TypeError("Failed to fetch"));
      await expect(answer.promise).rejects.toBeInstanceOf(TypeError);
    });
    expect(s.onError).toHaveBeenCalledTimes(1);
    expect(s.onError.mock.calls[0]![2]).toEqual({ rejected: false });
    expect(rejections).toEqual([]);
    expect(ids(s.hook.result.current.list)).toEqual(["b"]);
    expect(s.hook.result.current.row).toMatchObject({
      pending: true,
      row: done("a"),
    });
  });

  it("an op not done by its deadline files a censored confirm sample", async () => {
    const w = world(50);
    const s = setup(w, () => new Promise<unknown>(() => {}));
    await waitFor(() =>
      expect(s.hook.result.current.list.status).toBe("ready"),
    );
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    act(() => {
      s.hook.result.current.write.mutate({ params: { id: "a" } });
    });
    act(() => {
      vi.advanceTimersByTime(49);
    });
    expect(samples).toEqual([]);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(samples).toHaveLength(1);
    expect(samples[0]).toMatchObject({
      signal: "confirm",
      censored: true,
      key: w.exit.route,
      variant: `predict/${w.exit.route}/unconfirmed/awaiting-ack`,
    });
  });
});
