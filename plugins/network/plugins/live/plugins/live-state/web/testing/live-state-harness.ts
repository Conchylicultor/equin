import { onTestFinished } from "vitest";
import { QueryClient, type DefaultOptions } from "@tanstack/react-query";
import { createElement, type ReactElement, type ReactNode } from "react";
import type { Transport } from "@plugins/primitives/plugins/networking/web";
import {
  testTransport,
  transportWrapper,
} from "@plugins/primitives/plugins/networking/web/testing";
import { NotificationsClient } from "../notifications-client";
import { NotificationsClientProvider } from "../use-resource";

export interface LiveStateHarness {
  /**
   * Mounts this harness's transport and pair — the `TransportProvider` +
   * `NotificationsProvider` of a test.
   */
  Wrapper: (props: { children: ReactNode }) => ReactElement;
  /** The transport `Wrapper` mounts and `notifications` talks through. */
  transport: Transport;
  /** The cache `notifications` writes and `Wrapper` mounts: one cache. */
  queryClient: QueryClient;
  notifications: NotificationsClient;
  /** Destroy the client (sockets, bus subscriptions, teardown timers). Idempotent. */
  dispose: () => void;
}

export interface LiveStateHarnessOptions {
  /** Query defaults over the harness's own (no retry, no refetch on mount, never stale). */
  queries?: DefaultOptions["queries"];
  /**
   * The transport the tree resolves (`useTransport()`), and the one the
   * client opens its sockets / fetches through. Omitted: a `testTransport()`
   * for the tree, and the client on its own defaults (the global
   * `SharedWebSocket` / `fetch`, which a test may mock). A fake fetcher's
   * (`endpoints/web/testing`'s `fakeFetchEndpoint(...).transport`) makes the
   * endpoint clients under it answer from the fake.
   */
  transport?: Transport;
}

/**
 * A fresh `NotificationsClient` and the `QueryClient` it owns, under a
 * transport, for ONE test — what the app's `TransportProvider` +
 * `NotificationsProvider` mount, minus the page's pipeline (which keeps the
 * first cache it was built with, so a second test would mount a cache nothing
 * writes). Disposed when the test finishes; created outside a running
 * test (a module- or describe-level harness, shared by every test) it throws.
 */
export function createLiveStateHarness(
  options: LiveStateHarnessOptions = {},
): LiveStateHarness {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        refetchOnMount: false,
        staleTime: Infinity,
        ...options.queries,
      },
    },
  });
  const given = options.transport;
  const transport = given ?? testTransport();
  const notifications = new NotificationsClient(
    queryClient,
    given && {
      makeSocket: (url, socketOptions) => given.openSocket(url, socketOptions),
      socketUrl: (path) => given.socketUrl(path),
      fetchImpl: (input, init) => given.fetch(input, init),
    },
  );
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    notifications.destroy();
  };
  onTestFinished(dispose);
  const TransportMount = transportWrapper(transport);
  const Wrapper = ({ children }: { children: ReactNode }) =>
    createElement(TransportMount, {
      children: createElement(NotificationsClientProvider, {
        client: notifications,
        children,
      }),
    });
  return { Wrapper, transport, queryClient, notifications, dispose };
}
