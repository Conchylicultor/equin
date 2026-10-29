/**
 * The predict vocabulary's closed gaps, end to end over a
 * `createLiveStateHarness` and a fake endpoint fetcher: an increment
 * (`applyRows`, nothing to compare) stays through an ack that lands before its
 * frame and is confirmed by the tuple's ack of the commit the server named; an
 * upsert turns a by-id read's `found: false` into the predicted row; a value
 * patch shows in `useLive(value, params)` and is confirmed by a full frame's
 * watermark past its commit; an ack naming no commit confirms at the ack.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@plugins/primitives/plugins/log-channels/web", () => ({
  clientLog: () => {},
}));

import { act, renderHook, waitFor } from "@testing-library/react";
import { z } from "zod";
import { textField } from "@plugins/fields/plugins/text/plugins/config/core";
import { intField } from "@plugins/fields/plugins/int/plugins/config/core";
import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";
import { entityRef } from "@plugins/infra/plugins/entities/core";
import { fakeFetchEndpoint } from "@plugins/infra/plugins/endpoints/web/testing";
import {
  applyRows,
  liveCollection,
  liveValue,
  patchValue,
  upsertRow,
  upsertRows,
} from "@plugins/network/plugins/live/core";
import {
  useLive,
  useLiveMutation,
  useLiveRow,
} from "@plugins/network/plugins/live/web";
import {
  queryKeyFor,
  type ResourceResult,
} from "@plugins/primitives/plugins/live-state/web";
import { createLiveStateHarness } from "@plugins/primitives/plugins/live-state/web/testing";
import {
  clientLatencySink,
  type ClientLatencySample,
} from "@plugins/primitives/plugins/perfs/plugins/latency-signal/core";
import type { FetchEndpointCall } from "@plugins/infra/plugins/endpoints/web/testing";

let seq = 0;

function world() {
  const n = seq++;
  const scores = entityRef(`pg_scores_${n}`, {
    id: textField(),
    points: intField({ label: "Points" }),
  });
  const byId = liveCollection(`pg.by-id.${n}`, {
    from: scores,
    carry: { pick: ["id", "points"] },
    id: "id",
  });
  const bump = defineEndpoint({
    route: `POST /api/pg${n}/:id/bump`,
    effect: (on) =>
      applyRows(
        on,
        scores,
        ({ params }) => [params.id],
        (rows) => rows.map((r) => ({ ...r, points: r.points + 1 })),
      ),
  });
  const set = defineEndpoint({
    route: `POST /api/pg${n}/:id/set`,
    body: z.object({ points: z.number() }),
    effect: (on) =>
      upsertRow(
        on,
        scores,
        ({ params }) => params.id,
        (_row, { params, body }) => ({ id: params.id, points: body.points }),
      ),
  });
  const picks = liveValue(`pg.picks.${n}`, {
    schema: z.object({ slot: z.string().nullable() }),
    params: ["name"],
  });
  const pick = defineEndpoint({
    route: `POST /api/pg${n}/pick/:name`,
    body: z.object({ slot: z.string() }),
    effect: (on) =>
      patchValue(
        on,
        picks,
        ({ params }) => ({ name: params.name }),
        (_v, { body }) => ({ slot: body.slot }),
      ),
  });
  // A scoped `all` set declaring no `membership`: every row of its scope.
  const items = entityRef(`pg_items_${n}`, {
    id: textField(),
    pageId: textField(),
    label: textField({ label: "Label" }),
  });
  const pageItems = liveCollection(`pg.page-items.${n}`, {
    from: items,
    carry: { pick: ["id", "pageId", "label"] },
    id: "id",
    all: {
      by: ["pageId"],
      orderBy: [["label", "asc"]],
      unbounded: { reason: "test" },
    },
  });
  const label = defineEndpoint({
    route: `POST /api/pg${n}/items/label`,
    body: z.object({
      pageId: z.string(),
      ids: z.array(z.string()),
      label: z.string(),
    }),
    effect: (on) =>
      upsertRows(
        on,
        items,
        ({ body }) => body.ids,
        (row, { body }, id) => ({
          ...(row ?? { id, pageId: body.pageId }),
          label: body.label,
        }),
      ),
  });
  // A discriminated-union body: one request type, not one per arm.
  const choice = defineEndpoint({
    route: `POST /api/pg${n}/:id/choice`,
    body: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("set"), points: z.number() }),
      z.object({ kind: z.literal("reset") }),
    ]),
    effect: (on) =>
      upsertRow(
        on,
        scores,
        ({ params }) => params.id,
        (_row, { params, body }) => ({
          id: params.id,
          points: body.kind === "set" ? body.points : 0,
        }),
      ),
  });
  return { byId, bump, set, picks, pick, pageItems, label, choice };
}

/** A fetch answer the test settles by hand, naming `commits` in its ack. */
function ackLater() {
  let release!: (commits: readonly string[]) => void;
  const answer = (call: FetchEndpointCall): Promise<unknown> =>
    new Promise((resolve) => {
      release = (commits) => {
        call.opts?.onCommits?.(commits);
        resolve(undefined);
      };
    });
  return {
    answer,
    release: (commits: readonly string[]) => release(commits),
  };
}

describe("predicted writes — the closed gaps", () => {
  let samples: ClientLatencySample[];
  let off: () => void;
  beforeEach(() => {
    samples = [];
    off = clientLatencySink.subscribe((s) => samples.push(s));
  });
  afterEach(() => off());
  const confirms = () => samples.filter((s) => s.signal === "confirm");

  it("an increment stays through an ack that lands before its frame, until the tuple acks its commit", async () => {
    const w = world();
    const ack = ackLater();
    const fake = fakeFetchEndpoint(ack.answer);
    const live = createLiveStateHarness({ transport: fake.transport });
    const key = queryKeyFor(w.byId.rows.key, { ids: "a" });
    live.queryClient.setQueryData(key, [{ id: "a", points: 1 }]);
    const hook = renderHook(
      () => ({
        row: useLiveRow(w.byId, "a"),
        write: useLiveMutation(w.bump),
      }),
      { wrapper: live.Wrapper },
    );
    await waitFor(() =>
      expect(hook.result.current.row).toMatchObject({ found: true }),
    );
    act(() => hook.result.current.write.mutate({ params: { id: "a" } }));
    expect(hook.result.current.row).toMatchObject({
      row: { id: "a", points: 2 },
      pending: true,
    });
    // The ack lands first, naming commit 700.
    await act(async () => {
      ack.release(["700"]);
      await Promise.resolve();
    });
    expect(hook.result.current.row).toMatchObject({
      row: { id: "a", points: 2 },
      pending: true,
    });
    // A frame of an earlier write: the +1 does not vanish.
    act(() => {
      live.queryClient.setQueryData(key, [{ id: "a", points: 1 }]);
    });
    expect(hook.result.current.row).toMatchObject({
      row: { id: "a", points: 2 },
    });
    expect(confirms()).toEqual([]);
    // The frame carrying commit 700 (its ack noted before the cache write).
    act(() => {
      live.notifications.registries.txAcks.note(w.byId.rows.key, { ids: "a" }, [
        "700",
      ]);
      live.queryClient.setQueryData(key, [{ id: "a", points: 2 }]);
    });
    await waitFor(() => expect(confirms()).toHaveLength(1));
    expect(hook.result.current.row).toMatchObject({
      row: { id: "a", points: 2 },
      pending: false,
    });
  });

  it("an ack naming no commit confirms at the ack", async () => {
    const w = world();
    const ack = ackLater();
    const fake = fakeFetchEndpoint(ack.answer);
    const live = createLiveStateHarness({ transport: fake.transport });
    const key = queryKeyFor(w.byId.rows.key, { ids: "a" });
    live.queryClient.setQueryData(key, [{ id: "a", points: 1 }]);
    const hook = renderHook(
      () => ({
        row: useLiveRow(w.byId, "a"),
        write: useLiveMutation(w.bump),
      }),
      { wrapper: live.Wrapper },
    );
    await waitFor(() =>
      expect(hook.result.current.row).toMatchObject({ found: true }),
    );
    act(() => hook.result.current.write.mutate({ params: { id: "a" } }));
    await act(async () => {
      ack.release([]);
      await Promise.resolve();
    });
    await waitFor(() => expect(confirms()).toHaveLength(1));
    expect(hook.result.current.row).toMatchObject({
      row: { id: "a", points: 1 },
      pending: false,
    });
  });

  it("an upsert turns a by-id read's absent row into the predicted one", async () => {
    const w = world();
    const ack = ackLater();
    const fake = fakeFetchEndpoint(ack.answer);
    const live = createLiveStateHarness({ transport: fake.transport });
    const key = queryKeyFor(w.byId.rows.key, { ids: "n" });
    live.queryClient.setQueryData(key, []);
    const hook = renderHook(
      () => ({
        row: useLiveRow(w.byId, "n"),
        write: useLiveMutation(w.set),
      }),
      { wrapper: live.Wrapper },
    );
    await waitFor(() =>
      expect(hook.result.current.row).toMatchObject({
        status: "ready",
        found: false,
      }),
    );
    act(() =>
      hook.result.current.write.mutate({
        params: { id: "n" },
        body: { points: 5 },
      }),
    );
    expect(hook.result.current.row).toMatchObject({
      status: "ready",
      found: true,
      pending: true,
      row: { id: "n", points: 5 },
    });
    await act(async () => {
      ack.release(["41"]);
      await Promise.resolve();
    });
    act(() => {
      live.notifications.registries.txAcks.note(w.byId.rows.key, { ids: "n" }, [
        "41",
      ]);
      live.queryClient.setQueryData(key, [{ id: "n", points: 5 }]);
    });
    await waitFor(() => expect(confirms()).toHaveLength(1));
    expect(hook.result.current.row).toMatchObject({
      found: true,
      pending: false,
      row: { id: "n", points: 5 },
    });
  });

  it("a value patch shows in useLive(value, params); a full frame's watermark past its commit confirms it", async () => {
    const w = world();
    const ack = ackLater();
    const fake = fakeFetchEndpoint(ack.answer);
    const live = createLiveStateHarness({ transport: fake.transport });
    const key = queryKeyFor(w.picks.key, { name: "p" });
    live.queryClient.setQueryData(key, { slot: null });
    const hook = renderHook(
      () => ({
        value: useLive(w.picks, { name: "p" }) as ResourceResult<{
          slot: string | null;
        }>,
        write: useLiveMutation(w.pick),
      }),
      { wrapper: live.Wrapper },
    );
    await waitFor(() => expect(hook.result.current.value.status).toBe("ready"));
    act(() =>
      hook.result.current.write.mutate({
        params: { name: "p" },
        body: { slot: "x" },
      }),
    );
    expect(hook.result.current.value).toMatchObject({
      status: "ready",
      data: { slot: "x" },
    });

    await act(async () => {
      ack.release(["90"]);
      await Promise.resolve();
    });
    expect(confirms()).toEqual([]);
    // A full frame captured past commit 90 (xmin 91 > 90).
    act(() => {
      live.notifications.registries.watermarks.note(
        w.picks.key,
        { name: "p" },
        "91",
      );
      live.queryClient.setQueryData(key, { slot: "x" });
    });
    await waitFor(() => expect(confirms()).toHaveLength(1));
    expect(hook.result.current.value).toMatchObject({
      status: "ready",
      data: { slot: "x" },
    });
  });
  it("an upsert enters a scoped `all` set that declares no membership — in its scope only, in its order", async () => {
    const w = world();
    const ack = ackLater();
    const fake = fakeFetchEndpoint(ack.answer);
    const live = createLiveStateHarness({ transport: fake.transport });
    const p1 = queryKeyFor(w.pageItems.key, { pageId: "p1" });
    const p2 = queryKeyFor(w.pageItems.key, { pageId: "p2" });
    live.queryClient.setQueryData(p1, [{ id: "a", pageId: "p1", label: "m" }]);
    live.queryClient.setQueryData(p2, []);
    const hook = renderHook(
      () => ({
        p1: useLive(w.pageItems, { where: { pageId: "p1" } }),
        p2: useLive(w.pageItems, { where: { pageId: "p2" } }),
        write: useLiveMutation(w.label),
      }),
      { wrapper: live.Wrapper },
    );
    await waitFor(() =>
      expect(hook.result.current.p1).toMatchObject({ status: "ready" }),
    );
    act(() =>
      hook.result.current.write.mutate({
        body: { pageId: "p1", ids: ["b", "a"], label: "a" },
      }),
    );
    expect(hook.result.current.p1).toMatchObject({
      status: "ready",
      data: [
        { id: "a", pageId: "p1", label: "a" },
        { id: "b", pageId: "p1", label: "a" },
      ],
    });
    // Another scope's tuple gains nothing.
    expect(hook.result.current.p2).toMatchObject({ status: "ready", data: [] });
  });

  it("mutate takes a discriminated-union body as one request, and its own callbacks", async () => {
    const w = world();
    const ack = ackLater();
    const fake = fakeFetchEndpoint(ack.answer);
    const live = createLiveStateHarness({ transport: fake.transport });
    const hook = renderHook(() => useLiveMutation(w.choice), {
      wrapper: live.Wrapper,
    });
    const body = { kind: "reset" } as
      { kind: "set"; points: number } | { kind: "reset" };
    const done = vi.fn();
    act(() =>
      hook.result.current.mutate(
        { params: { id: "x" }, body },
        { onSuccess: done },
      ),
    );
    expect(done).not.toHaveBeenCalled();
    await act(async () => {
      ack.release([]);
      await Promise.resolve();
    });
    await waitFor(() => expect(done).toHaveBeenCalledTimes(1));
  });
});
