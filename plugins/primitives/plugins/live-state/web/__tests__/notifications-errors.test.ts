/**
 * NotificationsClient's failing-read bookkeeping, on the REAL client over a
 * `createTransportHub()` and a real `QueryClient`:
 *
 *   - the sticky-error fix: a value-less `up-to-date` reply clears the tuple's
 *     query error WITHOUT writing its data (same reference, same
 *     `dataUpdatedAt`);
 *   - event-driven retry: `online` and `visibilitychange → visible` refetch only
 *     the queries currently in error — never a healthy one;
 *   - the report sink fires once per `(key, params)` failure episode, however
 *     many observers the query has and however many retries fail again, and
 *     re-arms once the error clears; a query this client does not subscribe to
 *     never reports;
 *   - `getFailingResources` lists exactly the failing tuples.
 *
 * Errors are driven the way they happen in the app: a query whose `queryFn`
 * rejects, refetched through a `QueryObserver` (the object `useQuery` uses).
 */

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("@plugins/primitives/plugins/log-channels/web", () => ({
  clientLog: () => {},
}));

import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { z } from "zod";
import {
  createTransportHub,
  type FakeWebSocket,
} from "@plugins/primitives/plugins/networking/web/testing";
import { NotificationsClient } from "../notifications-client";
import {
  resourceErrorReportSink,
  type ResourceErrorInfo,
} from "../resource-error-reporter";
import { ResourceHttpError } from "../resource-http-errors";

const schema = z.object({ status: z.string() });

const flush = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(0);
};

describe("NotificationsClient — failing reads", () => {
  const clients: NotificationsClient[] = [];
  const unsubs: (() => void)[] = [];
  let reported: ResourceErrorInfo[] = [];

  async function setup(): Promise<{
    hub: ReturnType<typeof createTransportHub>;
    qc: QueryClient;
    client: NotificationsClient;
    socket: FakeWebSocket;
  }> {
    const hub = createTransportHub();
    // No retry: one rejected queryFn sets the error at once.
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    const tab = hub.tab();
    const client = new NotificationsClient(qc, {
      makeSocket: hub.makeSocket(tab),
    });
    clients.push(client);
    await flush();
    const socket = hub.server.all()[0]!;
    socket.open();
    await flush();
    return { hub, qc, client, socket };
  }

  /** Observe `key` with a `queryFn` the test scripts; returns the observer. */
  function watch(
    qc: QueryClient,
    key: string,
    queryFn: () => Promise<unknown>,
  ) {
    const observer = new QueryObserver(qc, {
      queryKey: [key],
      queryFn,
      enabled: false,
    });
    unsubs.push(observer.subscribe(() => {}));
    return observer;
  }

  async function subAck(
    socket: FakeWebSocket,
    key: string,
    version = 1,
  ): Promise<void> {
    socket.serverSend({
      kind: "sub-ack",
      key,
      params: {},
      value: { status: `${key}-v${version}` },
      version,
      epoch: "boot-1",
    });
    await flush();
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    reported = [];
    resourceErrorReportSink.register((info) => reported.push(info));
  });

  afterEach(() => {
    for (const u of unsubs.splice(0)) u();
    for (const c of clients.splice(0)) c.destroy();
    resourceErrorReportSink.register(null);
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  test("an up-to-date reply clears a sticky error without rewriting the data", async () => {
    const { hub, qc, client, socket } = await setup();
    client.observe("k", {}, undefined, { schema });
    await subAck(socket, "k");
    const observer = watch(qc, "k", () =>
      Promise.reject(new ResourceHttpError("k", 500, "loader-failed")),
    );
    await observer.refetch();
    const before = qc.getQueryState(["k"])!;
    expect(before.error).toBeInstanceOf(ResourceHttpError);
    const data = qc.getQueryData(["k"]);

    // Reconnect within the same boot: the replay is answered `up-to-date`.
    socket.serverClose();
    await vi.advanceTimersByTimeAsync(500);
    const socket2 = hub.server.all().find((s) => s.readyState === 0)!;
    socket2.open();
    await flush();
    socket2.serverSend({
      kind: "up-to-date-batch",
      epoch: "boot-1",
      entries: [{ key: "k", params: {}, version: 1 }],
    });
    await flush();

    const after = qc.getQueryState(["k"])!;
    expect(after.error).toBeNull();
    expect(after.status).toBe("success");
    // No data write: the same value, never re-stamped.
    expect(qc.getQueryData(["k"])).toBe(data);
    expect(after.dataUpdatedAt).toBe(before.dataUpdatedAt);
    expect(client.getFailingResources()).toEqual([]);
  });

  test("online and visible refetch only the reads in error", async () => {
    const { qc, client, socket } = await setup();
    client.observe("bad", {}, undefined, { schema });
    client.observe("good", {}, undefined, { schema });
    await subAck(socket, "bad");
    await subAck(socket, "good");
    const badFn = vi.fn(() => Promise.reject(new TypeError("offline")));
    const goodFn = vi.fn(() => Promise.resolve({ status: "fine" }));
    const bad = watch(qc, "bad", badFn);
    watch(qc, "good", goodFn);
    await bad.refetch();
    expect(badFn).toHaveBeenCalledTimes(1);

    window.dispatchEvent(new Event("online"));
    await flush();
    expect(badFn).toHaveBeenCalledTimes(2);
    expect(goodFn).not.toHaveBeenCalled();

    const visibility = vi
      .spyOn(document, "visibilityState", "get")
      .mockReturnValue("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    await flush();
    expect(badFn).toHaveBeenCalledTimes(2); // hidden: nothing to do

    visibility.mockReturnValue("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    await flush();
    expect(badFn).toHaveBeenCalledTimes(3);
    expect(goodFn).not.toHaveBeenCalled();
  });

  test("a retry that succeeds clears the failure", async () => {
    const { qc, client, socket } = await setup();
    client.observe("k", {}, undefined, { schema });
    await subAck(socket, "k");
    let fail = true;
    const observer = watch(qc, "k", () =>
      fail
        ? Promise.reject(new TypeError("offline"))
        : Promise.resolve({ status: "back" }),
    );
    await observer.refetch();
    expect(client.getFailingResources()).toHaveLength(1);
    fail = false;
    window.dispatchEvent(new Event("online"));
    await flush();
    expect(qc.getQueryState(["k"])!.error).toBeNull();
    expect(client.getFailingResources()).toEqual([]);
  });

  test("the sink fires once per failure episode, however many observers, and re-arms after it clears", async () => {
    const { qc, client, socket } = await setup();
    client.observe("k", {}, undefined, { schema });
    await subAck(socket, "k");
    const fn = () =>
      Promise.reject(new ResourceHttpError("k", 500, "loader-failed"));
    const a = watch(qc, "k", fn);
    watch(qc, "k", fn);
    watch(qc, "k", fn);

    await a.refetch();
    expect(reported).toHaveLength(1);
    expect(reported[0]!.key).toBe("k");
    expect(reported[0]!.error.kind).toBe("loader-failed");

    // Fails again: the same episode, not a new report.
    await a.refetch();
    expect(reported).toHaveLength(1);
    expect(client.getFailingResources()).toHaveLength(1);

    // A push heals it (RQ's success action resets the error)…
    await subAck(socket, "k", 2);
    expect(client.getFailingResources()).toEqual([]);
    // …so the next failure is a new episode.
    await a.refetch();
    expect(reported).toHaveLength(2);
  });

  test("a query this client does not subscribe to never reports", async () => {
    const { qc, client } = await setup();
    const observer = watch(qc, "not-a-resource", () =>
      Promise.reject(new Error("endpoint failure")),
    );
    await observer.refetch();
    expect(reported).toEqual([]);
    expect(client.getFailingResources()).toEqual([]);
  });
});
