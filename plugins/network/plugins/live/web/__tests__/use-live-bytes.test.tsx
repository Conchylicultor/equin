/**
 * useLive over a `bytes: true` value: the read is an HTTP read of an
 * `application/octet-stream` body (its envelope in response headers), and the
 * result is a `ResourceResult<ArrayBuffer>`. A declared `maxBytes` types the
 * `"too-large"` refusal on the error arm. Harness: a real NotificationsProvider
 * + QueryClient + the real HTTP read (`fetchOverHttp`), the network `fetch`
 * stubbed with real `Response`s.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@plugins/primitives/plugins/log-channels/web", () => ({
  clientLog: () => {},
}));

import { renderHook, waitFor } from "@testing-library/react";
import { z } from "zod";
import { type ResourceResult } from "@plugins/primitives/plugins/live-state/web";
import {
  createLiveStateHarness,
  type LiveStateHarness,
  resetResourceContractMismatches,
} from "@plugins/primitives/plugins/live-state/web/testing";
import { resourceBytesHeaders } from "@plugins/packages/plugins/resource-protocol/core";
import { liveValue } from "@plugins/network/plugins/live/core";
import { useLive } from "@plugins/network/plugins/live/web";

let seq = 0;
const key = () => `test.use-live-bytes.${seq++}`;

function mount<R>(live: LiveStateHarness, useHook: () => R) {
  const notifications = live.notifications;
  // Before the first render: a fresh client would cold-start prime over HTTP.
  vi.spyOn(notifications, "hasEverBeenReady").mockReturnValue(true);
  const rendered = renderHook(useHook, { wrapper: live.Wrapper });
  return rendered;
}

/** The network answers every resource read with `respond(url)`. */
function answer(respond: (url: string) => Response) {
  const fetch = vi.fn((url: string) => Promise.resolve(respond(url)));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

afterEach(() => {
  vi.unstubAllGlobals();
  resetResourceContractMismatches();
});

describe("useLive — a bytes value", () => {
  it("reads the octet-stream body into an ArrayBuffer", async () => {
    const v = liveValue(key(), { bytes: true, params: ["path"] });
    const fetch = answer(
      () =>
        new Response(new Uint8Array([7, 8, 9]), {
          headers: resourceBytesHeaders({ version: 3, epoch: "boot" }),
        }),
    );
    const { result } = mount(createLiveStateHarness(), () =>
      useLive(v, { path: "a.png" }),
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));
    const r = result.current;
    if (r.status !== "ready") throw new Error("unreachable");
    // Typed: the ready arm's data IS an ArrayBuffer.
    const data: ArrayBuffer = r.data;
    expect(Object.prototype.toString.call(data)).toBe("[object ArrayBuffer]");
    expect([...new Uint8Array(data)]).toEqual([7, 8, 9]);
    expect(String(fetch.mock.calls[0]?.[0])).toContain("path=a.png");
  });

  it("a JSON answer to a bytes read is a failure, not a value", async () => {
    const v = liveValue(key(), { bytes: true, params: ["path"] });
    answer(
      () =>
        new Response(JSON.stringify({ value: "x", version: 1, epoch: "e" }), {
          headers: { "content-type": "application/json" },
        }),
    );
    const { result } = mount(createLiveStateHarness(), () =>
      useLive(v, { path: "p" }),
    );
    await waitFor(() => expect(result.current.status).toBe("error"));
  });

  it("maxBytes types the too-large refusal on the error arm", async () => {
    const v = liveValue(key(), {
      bytes: true,
      params: ["path"],
      maxBytes: 4,
      refusals: ["missing"],
    });
    answer(
      () =>
        new Response(
          JSON.stringify({
            reason: "refused",
            code: "too-large",
            detail: "5 bytes is over the 4-byte limit",
          }),
          { status: 422, headers: { "content-type": "application/json" } },
        ),
    );
    const { result } = mount(createLiveStateHarness(), () =>
      useLive(v, { path: "p" }),
    );
    await waitFor(() => expect(result.current.status).toBe("error"));
    const r = result.current;
    if (r.status !== "error") throw new Error("unreachable");
    expect(r.error.kind).toBe("refused");
    const code: "missing" | "too-large" | undefined = r.error.code;
    expect(code).toBe("too-large");
  });

  it("types: useLive answers ResourceResult<ArrayBuffer>", () => {
    const v = liveValue(key(), { bytes: true, params: ["path"] });
    const q = liveValue(key(), {
      bytes: true,
      query: z.object({ path: z.string() }),
    });
    // Never called — the assertions are the annotations and the `@ts-expect-error`s.
    const useTypeOnly = () => {
      const plain: ResourceResult<ArrayBuffer> = useLive(v, { path: "p" });
      const queried: ResourceResult<ArrayBuffer> = useLive(q, { path: "p" });
      // @ts-expect-error — the payload is bytes, not text
      const text: ResourceResult<string> = useLive(v, { path: "p" });
      return [plain, queried, text];
    };
    expect(typeof useTypeOnly).toBe("function");
  });
});
