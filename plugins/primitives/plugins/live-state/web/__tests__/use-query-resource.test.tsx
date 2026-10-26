/**
 * `useQueryResource` — a local async load (a TanStack query) read as a
 * `ResourceResult`, against a real `QueryClient`:
 *
 *   - loading until the value lands, then ready;
 *   - a failure is the error arm, classified (a thrown error → loader-failed,
 *     no answer → transport, schema → client-outdated);
 *   - a failed refetch keeps the last value as `stale`; a refetch heals it.
 */

import { describe, expect, it } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { z } from "zod";
import {
  ResourceError,
  useQueryResource,
} from "@plugins/primitives/plugins/live-state/web";

function wrapper(): (props: { children: ReactNode }) => ReactNode {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  return ({ children }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

/** A promise the test settles by hand. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("useQueryResource", () => {
  it("is loading until the value lands, then ready", async () => {
    const d = deferred<number>();
    const { result } = renderHook(
      () => useQueryResource({ queryKey: ["n"], queryFn: () => d.promise }),
      { wrapper: wrapper() },
    );
    expect(result.current.status).toBe("loading");
    await act(async () => d.resolve(7));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    const r = result.current;
    expect(r.status === "ready" && r.data).toBe(7);
  });

  it.each([
    ["a thrown error", () => new Error("boom"), "loader-failed"],
    ["no answer", () => new TypeError("Failed to fetch"), "transport"],
    [
      "a schema rejection",
      () => z.number().safeParse("x").error!,
      "client-outdated",
    ],
  ] as const)("classifies %s", async (_name, make, kind) => {
    const { result } = renderHook(
      () =>
        useQueryResource({
          queryKey: ["fail", kind],
          queryFn: (): Promise<number> => Promise.reject(make()),
        }),
      { wrapper: wrapper() },
    );
    await waitFor(() => expect(result.current.status).toBe("error"));
    const r = result.current;
    if (r.status !== "error") throw new Error("unreachable");
    expect(r.error).toBeInstanceOf(ResourceError);
    expect(r.error.kind).toBe(kind);
    expect(r.stale).toBeUndefined();
  });

  it("keeps the last value as stale when a refetch fails, and a refetch heals it", async () => {
    let call = 0;
    const { result } = renderHook(
      () =>
        useQueryResource({
          queryKey: ["flaky"],
          queryFn: () => {
            call += 1;
            if (call === 2) return Promise.reject(new Error("busy"));
            return Promise.resolve(call);
          },
        }),
      { wrapper: wrapper() },
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));
    await act(() => result.current.refetch());
    await waitFor(() => expect(result.current.status).toBe("error"));
    const failed = result.current;
    if (failed.status !== "error") throw new Error("unreachable");
    expect(failed.stale).toBe(1);
    expect(failed.error.kind).toBe("loader-failed");
    await act(() => result.current.refetch());
    await waitFor(() => expect(result.current.status).toBe("ready"));
    const healed = result.current;
    expect(healed.status === "ready" && healed.data).toBe(3);
  });

  it("is memoized: a re-render with nothing new keeps the result's identity", async () => {
    const { result, rerender } = renderHook(
      () => useQueryResource({ queryKey: ["memo"], queryFn: () => 1 }),
      { wrapper: wrapper() },
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
  });
});
