/**
 * useLiveReader — the event-shaped read of a live value (plan
 * research/2026-10-26-global-browser-reads-only-through-live.md §2): one
 * answer to one tuple, the tuple `useLive` subscribes. An observed, pushed
 * tuple is joined with no request; anything else is one HTTP read through the
 * transport (deduped per tuple) that never seeds the cache; a snapshot value
 * is always measured; a declared refusal is a typed answer, an undeclared one
 * a contract mismatch; a needsMachine value without the computer is
 * `unavailable` with no request; a failure rejects with its ResourceError,
 * reported once. The type checks at the end are tsc's (each `@ts-expect-error`
 * must be an error), in a function never called.
 *
 * Harness: a real NotificationsClient + QueryClient under a test transport
 * whose sockets run on `createTransportHub`'s fakes (so a sub-ack really lands
 * on an open socket) and whose `fetch` is scripted.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@plugins/primitives/plugins/log-channels/web", () => ({
  clientLog: () => {},
}));

import { renderHook } from "@testing-library/react";
import { z } from "zod";
import {
  queryKeyFor,
  ResourceError,
  resourceErrorReportSink,
} from "@plugins/primitives/plugins/live-state/web";
import {
  createLiveStateHarness,
  resetResourceContractMismatches,
  type LiveStateHarness,
  type ResourceErrorInfo,
} from "@plugins/primitives/plugins/live-state/web/testing";
import type { Transport } from "@plugins/primitives/plugins/networking/web";
import {
  createTransportHub,
  testTransport,
  type FakeWebSocket,
} from "@plugins/primitives/plugins/networking/web/testing";
import { textField } from "@plugins/fields/plugins/text/plugins/config/core";
import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";
import {
  liveCollection,
  liveValue,
  patchValue,
} from "@plugins/network/plugins/live/core";
import {
  useLive,
  useLiveMutation,
  useLiveReader,
} from "@plugins/network/plugins/live/web";
import type { LiveAnswer } from "../internal/use-live-reader";

const Result = z.object({ n: z.number() });
type Result = z.infer<typeof Result>;

let seq = 0;
const key = () => `test.use-live-reader.${seq++}`;

const flush = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(0);
};

/** A Response the client reads (status / ok / headers.get / json). */
function response(status: number, body: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: () => null },
    json: async () => body,
  } as unknown as Response;
}
const value = (n: number) => response(200, { value: { n }, version: 1 });

interface Setup {
  live: LiveStateHarness;
  socket: FakeWebSocket;
  /** Every request the transport's fetch was asked, by URL. */
  calls: string[];
  /** The scripted answers, in order (a function to answer a request lazily). */
  answers: (Response | Promise<Response> | Error)[];
  read: ReturnType<typeof useLiveReader>;
}

/** A harness whose socket is open, and its reader. */
async function setup(overrides: Partial<Transport> = {}): Promise<Setup> {
  const hub = createTransportHub();
  const tab = hub.tab();
  const calls: string[] = [];
  const answers: Setup["answers"] = [];
  const transport = testTransport({
    openSocket: hub.makeSocket(tab),
    fetch: (input) => {
      calls.push(String(input));
      const next = answers.shift();
      if (next === undefined)
        throw new Error(`no scripted answer for ${String(input)}`);
      return next instanceof Error
        ? Promise.reject(next)
        : Promise.resolve(next);
    },
    ...overrides,
  });
  const live = createLiveStateHarness({ transport });
  vi.spyOn(live.notifications, "hasEverBeenReady").mockReturnValue(true);
  await flush(); // elected → the worktree socket is created
  const socket = hub.server.all()[0]!;
  socket.open();
  await flush();
  const { result } = renderHook(() => useLiveReader(), {
    wrapper: live.Wrapper,
  });
  return { live, socket, calls, answers, read: result.current };
}

let reports: ResourceErrorInfo[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  reports = [];
  resourceErrorReportSink.register((r) => {
    reports.push(r);
  });
  // The global fetch is never the reader's: it reads through the transport.
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("the global fetch was called");
    }),
  );
});

afterEach(() => {
  resourceErrorReportSink.register(null);
  resetResourceContractMismatches();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("useLiveReader", () => {
  it("an unobserved tuple: one HTTP read through the transport, never written to the cache", async () => {
    const v = liveValue(key(), { schema: Result, params: ["dir"] });
    const { live, calls, answers, read } = await setup();
    answers.push(value(1));
    await expect(read(v, { dir: "a" })).resolves.toEqual({
      status: "ready",
      data: { n: 1 },
    });
    expect(calls).toEqual([`/api/resources/${v.key}?dir=a`]);
    expect(
      live.queryClient
        .getQueryCache()
        .find({ queryKey: queryKeyFor(v.key, { dir: "a" }), exact: true }),
    ).toBeUndefined();
    // Not a cache: the next ask reads again.
    answers.push(value(2));
    await expect(read(v, { dir: "a" })).resolves.toEqual({
      status: "ready",
      data: { n: 2 },
    });
    expect(calls).toHaveLength(2);
  });

  it("an observed tuple: its pushed value, no request", async () => {
    const v = liveValue(key(), { schema: Result, params: ["dir"] });
    const { live, socket, calls, read } = await setup();
    renderHook(() => useLive(v, { dir: "a" }), { wrapper: live.Wrapper });
    socket.serverSend({
      kind: "sub-ack",
      key: v.key,
      params: { dir: "a" },
      value: { n: 7 },
      version: 3,
      epoch: "b1",
    });
    await flush();
    const answer = await read(v, { dir: "a" });
    expect(answer).toEqual({ status: "ready", data: { n: 7 } });
    if (answer.status !== "ready") throw new Error("unreachable");
    // The cache's own object: the same value a `useLive` of it shows.
    expect(answer.data).toBe(
      live.queryClient.getQueryData(queryKeyFor(v.key, { dir: "a" })),
    );
    expect(calls).toEqual([]);
  });

  it("an observed tuple answers with the predicted writes its read shows", async () => {
    const v = liveValue(key(), { schema: Result, params: ["dir"] });
    const bump = defineEndpoint({
      route: `POST /api/${v.key}/:dir/bump`,
      effect: (on) =>
        patchValue(
          on,
          v,
          ({ params }) => ({ dir: params.dir }),
          (r) => ({ n: r.n + 1 }),
        ),
    });
    const { live, socket, answers, read } = await setup();
    const { result } = renderHook(
      () => ({ value: useLive(v, { dir: "a" }), write: useLiveMutation(bump) }),
      { wrapper: live.Wrapper },
    );
    socket.serverSend({
      kind: "sub-ack",
      key: v.key,
      params: { dir: "a" },
      value: { n: 7 },
      version: 3,
      epoch: "b1",
    });
    await flush();
    // The write is never answered: the prediction applies throughout.
    answers.push(new Promise<Response>(() => {}));
    result.current.write.mutate({ params: { dir: "a" } });
    await flush();
    expect(result.current.value).toMatchObject({ data: { n: 8 } });
    expect(await read(v, { dir: "a" })).toEqual({
      status: "ready",
      data: { n: 8 },
    });
  });

  it("an observed tuple with no value yet is read over HTTP, through the guarded write its readers share", async () => {
    const v = liveValue(key(), { schema: Result, params: ["dir"] });
    const { live, calls, answers, read } = await setup();
    renderHook(() => useLive(v, { dir: "a" }), { wrapper: live.Wrapper });
    answers.push(value(4));
    await expect(read(v, { dir: "a" })).resolves.toEqual({
      status: "ready",
      data: { n: 4 },
    });
    expect(calls).toHaveLength(1);
    expect(
      live.queryClient.getQueryData(queryKeyFor(v.key, { dir: "a" })),
    ).toEqual({ n: 4 });
  });

  it("the same tuple as useLive: an absent optional param and a typed query are one key", async () => {
    const plain = liveValue(key(), {
      schema: Result,
      params: ["path", "scopeId?"],
    });
    const typed = liveValue(key(), {
      schema: Result,
      query: z.object({ metric: z.string(), days: z.number().default(7) }),
    });
    const { live, socket, calls, read } = await setup();
    renderHook(() => useLive(plain, { path: "/x" }), {
      wrapper: live.Wrapper,
    });
    renderHook(() => useLive(typed, { metric: "m" }), {
      wrapper: live.Wrapper,
    });
    socket.serverSend({
      kind: "sub-ack",
      key: plain.key,
      params: { path: "/x" },
      value: { n: 1 },
      version: 1,
    });
    socket.serverSend({
      kind: "sub-ack",
      key: typed.key,
      params: typed.query.encode({ metric: "m" }),
      value: { n: 2 },
      version: 1,
    });
    await flush();
    // Spelled differently, asked as the same tuple: joined, no request.
    await expect(read(plain, { path: "/x", scopeId: "" })).resolves.toEqual({
      status: "ready",
      data: { n: 1 },
    });
    await expect(read(typed, { metric: "m", days: 7 })).resolves.toEqual({
      status: "ready",
      data: { n: 2 },
    });
    expect(calls).toEqual([]);
  });

  it("a snapshot value is measured on every ask, observed or not", async () => {
    const v = liveValue(key(), { schema: Result, load: "snapshot" });
    const { live, calls, answers, read } = await setup();
    answers.push(value(1)); // the observed reader's own mount read
    renderHook(() => useLive(v), { wrapper: live.Wrapper });
    await flush();
    expect(calls).toHaveLength(1);
    answers.push(value(2));
    await expect(read(v)).resolves.toEqual({ status: "ready", data: { n: 2 } });
    answers.push(value(3));
    await expect(read(v)).resolves.toEqual({ status: "ready", data: { n: 3 } });
    expect(calls).toHaveLength(3);
  });

  it("concurrent asks of one tuple share one request", async () => {
    const v = liveValue(key(), { schema: Result, params: ["dir"] });
    const { calls, answers, read } = await setup();
    let answer!: (r: Response) => void;
    answers.push(new Promise<Response>((resolve) => (answer = resolve)));
    const a = read(v, { dir: "a" });
    const b = read(v, { dir: "a" });
    answer(value(5));
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra).toEqual({ status: "ready", data: { n: 5 } });
    expect(rb).toBe(ra);
    expect(calls).toHaveLength(1);
  });

  it("a declared refusal is a typed answer, never a failure", async () => {
    const v = liveValue(key(), {
      schema: Result,
      params: ["path"],
      refusals: ["missing", "denied"],
    });
    const { answers, read } = await setup();
    answers.push(
      response(422, {
        reason: "refused",
        code: "missing",
        detail: "no such file",
      }),
    );
    await expect(read(v, { path: "/x" })).resolves.toEqual({
      status: "refused",
      code: "missing",
      message: "no such file",
    });
    expect(reports).toEqual([]);
  });

  it("a refusal code the declaration does not list is a contract mismatch: rejects, reported once", async () => {
    const v = liveValue(key(), {
      schema: Result,
      params: ["path"],
      refusals: ["missing"],
    });
    const { answers, read } = await setup();
    answers.push(
      response(422, { reason: "refused", code: "gone", detail: "went away" }),
    );
    const err: unknown = await read(v, { path: "/x" }).catch((e) => e);
    expect(err).toBeInstanceOf(ResourceError);
    expect((err as ResourceError).kind).toBe("client-outdated");
    expect(reports.map((r) => r.key)).toEqual([v.key]);
  });

  it("a failure rejects with its ResourceError, reported once per request however many asked", async () => {
    const v = liveValue(key(), { schema: Result });
    const { answers, read } = await setup();
    answers.push(new TypeError("Failed to fetch"));
    const results = await Promise.allSettled([read(v), read(v)]);
    for (const r of results) {
      expect(r.status).toBe("rejected");
      const reason = (r as PromiseRejectedResult).reason as ResourceError;
      expect(reason).toBeInstanceOf(ResourceError);
      expect(reason.kind).toBe("transport");
    }
    expect(reports).toHaveLength(1);
    answers.push(response(500, { reason: "loader-failed", detail: "boom" }));
    const failed: unknown = await read(v).catch((e) => e);
    expect((failed as ResourceError).kind).toBe("loader-failed");
    expect(reports).toHaveLength(2);
  });

  it("a needsMachine value under a transport without the computer: unavailable, no request", async () => {
    const v = liveValue(key(), {
      schema: Result,
      needsMachine: { feature: "Reading the checkout" },
    });
    const { calls, read } = await setup({ machine: false });
    await expect(read(v)).resolves.toEqual({
      status: "unavailable",
      message:
        "Reading the checkout isn't available in this version of the app — it needs equin running on your computer.",
    });
    expect(calls).toEqual([]);
  });

  it("reads through its own transport — a browser server's, a central value's route", async () => {
    const v = liveValue(key(), {
      schema: Result,
      params: ["dir"],
      origin: "central",
    });
    const { calls, answers, read } = await setup({
      socketUrl: (path) => `browser-server:${path}`,
    });
    answers.push(value(9));
    await expect(read(v, { dir: "a" })).resolves.toEqual({
      status: "ready",
      data: { n: 9 },
    });
    // The transport's fetch answered (the global one throws), on the central route.
    expect(calls).toEqual([`/api/central-resources/${v.key}?dir=a`]);
  });

  it("refuses at runtime what the types refuse: a collection, a null or a list", async () => {
    const v = liveValue(key(), { schema: Result, params: ["dir"] });
    const c = liveCollection(key(), {
      fields: { id: textField({ label: "Id" }) },
      id: "id",
    });
    const { read } = await setup();
    const untyped = read as unknown as (v: unknown, p?: unknown) => unknown;
    expect(() => untyped(c)).toThrow(/collection is read with useLive/);
    expect(() => untyped(v, null)).toThrow(/null params/);
    expect(() => untyped(v, [{ dir: "a" }])).toThrow(/a list of tuples/);
  });

  it("types: one tuple of a value, the answer typed by the declaration", () => {
    const plain = liveValue(key(), { schema: Result, params: ["dir"] });
    const none = liveValue(key(), { schema: Result });
    const refusing = liveValue(key(), {
      schema: Result,
      refusals: ["missing"],
    });
    const machine = liveValue(key(), {
      schema: Result,
      needsMachine: { feature: "x" },
    });
    const typed = liveValue(key(), {
      schema: Result,
      query: z.object({ metric: z.string() }),
    });
    const paged = liveValue(key(), {
      query: z.object({ dir: z.string() }),
      paged: {
        item: z.object({ id: z.string() }),
        id: "id",
        key: { of: (i) => [i.id], order: ["asc"] },
        limit: 10,
        maxLimit: 20,
      },
    });
    const collection = liveCollection(key(), {
      fields: { id: textField({ label: "Id" }) },
      id: "id",
    });
    // Never called — the assertions are tsc's.
    const typeOnly = async (read: ReturnType<typeof useLiveReader>) => {
      const a = await read(plain, { dir: "a" });
      if (a.status === "ready") {
        const data: Result = a.data;
        void data;
      }
      // A value that declares no refusals and needs no computer: ready only.
      const only: LiveAnswer<Result> = await read(none);
      // @ts-expect-error — not refusable, not unavailable: only "ready"
      void (only.status === "refused");
      const r = await read(refusing);
      if (r.status === "refused") {
        const code: "missing" = r.code;
        void code;
      }
      const m = await read(machine);
      if (m.status === "unavailable") void m.message;
      await read(typed, { metric: "m" });
      // @ts-expect-error — a param'd value needs its params
      await read(plain);
      // @ts-expect-error — no "not yet" in an await
      await read(plain, null);
      // @ts-expect-error — one question, one answer
      await read(plain, [{ dir: "a" }]);
      // @ts-expect-error — a typed query is asked with its question, not `{ q }`
      await read(typed, { q: "{}" });
      // @ts-expect-error — a paged value is read with useLive
      await read(paged, { dir: "a" });
      // @ts-expect-error — a collection is read with useLive
      await read(collection);
    };
    expect(typeof typeOnly).toBe("function");
  });
});
