/**
 * `useAssetSrc`: an asset is the path itself on a transport whose server a URL
 * reaches, a blob URL fetched through the transport otherwise (one per path,
 * shared, revoked with its last holder), and `unavailable` for a desktop-only
 * route on a transport without the computer.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import {
  testTransport,
  transportWrapper,
} from "@plugins/primitives/plugins/networking/web/testing";
import { assetPath, blob, defineEndpoint } from "../../core";
import { useAssetSrc } from "../internal/asset-src";

const getFile = defineEndpoint({
  route: "GET /api/files/:id",
  response: blob(),
});
const getHostFile = defineEndpoint({
  route: "GET /api/host/raw",
  response: blob(),
  needsMachine: { feature: "Reading a host file" },
});

let urls = 0;
const revoked: string[] = [];

// jsdom has no blob URLs: count them instead (and put back whatever was there).
const realCreate = Object.getOwnPropertyDescriptor(URL, "createObjectURL");
const realRevoke = Object.getOwnPropertyDescriptor(URL, "revokeObjectURL");

beforeEach(() => {
  urls = 0;
  revoked.length = 0;
  URL.createObjectURL = () => `blob:test/${++urls}`;
  URL.revokeObjectURL = (url: string) => {
    revoked.push(url);
  };
});

afterEach(() => {
  for (const [name, real] of [
    ["createObjectURL", realCreate],
    ["revokeObjectURL", realRevoke],
  ] as const) {
    if (real) Object.defineProperty(URL, name, real);
    else Reflect.deleteProperty(URL, name);
  }
});

describe("useAssetSrc", () => {
  it("is the path itself where a URL reaches the server", () => {
    const transport = testTransport();
    const { result } = renderHook(
      () => useAssetSrc(assetPath(getFile, { id: "a b" })),
      { wrapper: transportWrapper(transport) },
    );
    expect(result.current).toEqual({ kind: "ready", src: "/api/files/a%20b" });
  });

  it("fetches through the transport and shares one blob URL, revoked with its last holder", async () => {
    const fetch = vi.fn((_input: RequestInfo | URL) =>
      Promise.resolve(new Response("bytes")),
    );
    const transport = testTransport({ servesUrls: false, fetch });
    const wrapper = transportWrapper(transport);
    const useRead = () => useAssetSrc(assetPath(getFile, { id: "x" }));
    const first = renderHook(useRead, { wrapper });
    expect(first.result.current).toEqual({ kind: "loading" });
    await waitFor(() =>
      expect(first.result.current).toEqual({
        kind: "ready",
        src: "blob:test/1",
      }),
    );
    const second = renderHook(useRead, { wrapper });
    expect(second.result.current).toEqual({
      kind: "ready",
      src: "blob:test/1",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String(fetch.mock.calls[0]?.[0])).toBe("/api/files/x");

    first.unmount();
    await act(() => Promise.resolve());
    expect(revoked).toEqual([]);
    second.unmount();
    await act(() => Promise.resolve());
    expect(revoked).toEqual(["blob:test/1"]);
  });

  it("answers a failed fetch as an error", async () => {
    const transport = testTransport({
      servesUrls: false,
      fetch: () => Promise.resolve(new Response("", { status: 404 })),
    });
    const { result } = renderHook(
      () => useAssetSrc(assetPath(getFile, { id: "gone" })),
      { wrapper: transportWrapper(transport) },
    );
    await waitFor(() =>
      expect(result.current).toEqual({ kind: "error", message: "HTTP 404" }),
    );
  });

  it("is unavailable for a desktop-only route without the computer, fetching nothing", () => {
    const fetch = vi.fn(() => Promise.resolve(new Response("bytes")));
    const transport = testTransport({
      servesUrls: false,
      machine: false,
      fetch,
    });
    const { result } = renderHook(
      () => useAssetSrc(assetPath(getHostFile, {})),
      { wrapper: transportWrapper(transport) },
    );
    expect(result.current.kind).toBe("unavailable");
    expect(fetch).not.toHaveBeenCalled();
  });
});
