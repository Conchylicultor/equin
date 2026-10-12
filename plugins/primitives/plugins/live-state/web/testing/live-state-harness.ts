import { onTestFinished } from "vitest";
import { QueryClient, type DefaultOptions } from "@tanstack/react-query";
import { createElement, type ReactElement, type ReactNode } from "react";
import { NotificationsClient } from "../notifications-client";
import { NotificationsClientProvider } from "../use-resource";

export interface LiveStateHarness {
  /** Mounts this harness's pair — the `NotificationsProvider` of a test. */
  Wrapper: (props: { children: ReactNode }) => ReactElement;
  /** The cache `notifications` writes and `Wrapper` mounts: one cache. */
  queryClient: QueryClient;
  notifications: NotificationsClient;
  /** Destroy the client (sockets, bus subscriptions, teardown timers). Idempotent. */
  dispose: () => void;
}

export interface LiveStateHarnessOptions {
  /** Query defaults over the harness's own (no retry, no refetch on mount, never stale). */
  queries?: DefaultOptions["queries"];
}

/**
 * A fresh `NotificationsClient` and the `QueryClient` it owns, for ONE test —
 * what the app's `NotificationsProvider` mounts, minus the tab singleton (which
 * keeps the first cache it was built with, so a second test would mount a cache
 * nothing writes). Disposed when the test finishes; created outside a running
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
  const notifications = new NotificationsClient(queryClient);
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    notifications.destroy();
  };
  onTestFinished(dispose);
  const Wrapper = ({ children }: { children: ReactNode }) =>
    createElement(NotificationsClientProvider, {
      client: notifications,
      children,
    });
  return { Wrapper, queryClient, notifications, dispose };
}
