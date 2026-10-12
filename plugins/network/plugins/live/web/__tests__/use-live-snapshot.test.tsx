/**
 * useLive over a value declared `load: "snapshot"`: an on-demand read whose
 * result adds `refresh()` — the re-measure, an HTTP read (the server answers
 * every snapshot read by running its loader). Typed only on a snapshot read.
 * Harness: a real NotificationsProvider + QueryClient, the HTTP read stubbed at
 * the one HTTP path (`fetchOverHttp`), as in use-live-query.test.tsx.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("@plugins/primitives/plugins/log-channels/web", () => ({
  clientLog: () => {},
}));

import { renderHook, waitFor, act } from "@testing-library/react";
import { QueryClient } from "@tanstack/react-query";
import { type ReactNode } from "react";
import { z } from "zod";
import {
  NotificationsProvider,
  getNotificationsClient,
} from "@plugins/primitives/plugins/live-state/web";
import { NotificationsClient } from "@plugins/primitives/plugins/live-state/web/testing";
import { liveValue } from "@plugins/network/plugins/live/core";
import { useLive } from "@plugins/network/plugins/live/web";

const Result = z.object({ n: z.number() });
const Query = z.object({ metric: z.string() });

let seq = 0;
const key = () => `test.use-live-snapshot.${seq++}`;

function makeClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchOnMount: false, staleTime: Infinity },
    },
  });
}

function mount<R>(client: QueryClient, useHook: () => R) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <NotificationsProvider queryClient={client}>
      {children}
    </NotificationsProvider>
  );
  const rendered = renderHook(useHook, { wrapper });
  const notifications = getNotificationsClient();
  if (!notifications) throw new Error("NotificationsClient not created");
  vi.spyOn(notifications, "hasEverBeenReady").mockReturnValue(true);
  return { ...rendered, notifications };
}

describe("useLive — snapshot value", () => {
  it("reads over HTTP on mount, and refresh() re-measures", async () => {
    const v = liveValue(key(), { schema: Result, load: "snapshot" });
    // What the server would measure right now.
    let current = 1;
    const fetch = vi
      .spyOn(NotificationsClient.prototype, "fetchOverHttp")
      .mockImplementation(() => Promise.resolve({ n: current }) as never);
    const reads = () => fetch.mock.calls.filter(([k]) => k === v.key).length;
    const client = makeClient();
    const { result } = mount(client, () => useLive(v));
    await waitFor(() =>
      expect(result.current).toMatchObject({ status: "ready", data: { n: 1 } }),
    );
    // The truth moved; nothing tells a snapshot — refresh() re-measures.
    current = 2;
    const before = reads();
    await act(async () => {
      await result.current.refresh();
    });
    expect(reads()).toBe(before + 1);
    await waitFor(() =>
      expect(result.current).toMatchObject({ status: "ready", data: { n: 2 } }),
    );
    fetch.mockRestore();
  });

  it("a typed-query snapshot carries refresh() too", async () => {
    const v = liveValue(key(), {
      schema: Result,
      query: Query,
      load: "snapshot",
    });
    const fetch = vi
      .spyOn(NotificationsClient.prototype, "fetchOverHttp")
      .mockResolvedValue({ n: 7 } as never);
    const client = makeClient();
    const { result } = mount(client, () => useLive(v, { metric: "m" }));
    await waitFor(() =>
      expect(result.current).toMatchObject({ status: "ready", data: { n: 7 } }),
    );
    expect(typeof result.current.refresh).toBe("function");
    fetch.mockRestore();
  });

  it("types: refresh() only on a snapshot read", () => {
    const live = liveValue(key(), { schema: Result });
    const onDemand = liveValue(key(), { schema: Result, load: "on-demand" });
    // Never called — the assertions are the `@ts-expect-error`s.
    const useTypeOnly = () => {
      // @ts-expect-error — a pushed value is kept live: nothing to refresh
      void useLive(live).refresh();
      // @ts-expect-error — an on-demand value is invalidated: nothing to refresh
      void useLive(onDemand).refresh();
    };
    expect(typeof useTypeOnly).toBe("function");
  });
});
