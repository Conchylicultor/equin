import { afterEach, describe, expect, mock, test } from "bun:test";
import { z } from "zod";
import { defineEndpoint } from "../../core/define-endpoint";
import { unsupportedEndpointResponse } from "../../core/unsupported";
import { endpointErrorSink, type EndpointErrorInfo } from "./error-reporter";
import type { Transport } from "@plugins/primitives/plugins/networking/web";
import { EndpointError } from "../../core";
import { fetchEndpointOver } from "./fetch-endpoint";

const ping = defineEndpoint({
  route: "POST /api/ping",
  body: z.object({ n: z.number() }),
  response: z.object({ ok: z.boolean() }),
});

// Backoff of 1 ms keeps the retried cases instant; the schedule itself is
// fetchWithRetry's, not what these tests are about.
const RETRY = { retries: 2, backoffMs: 1 };

const realFetch = globalThis.fetch;

/** A page-shaped transport over the global fetch (read at call time, so a stub answers). */
const page: Transport = {
  socketUrl: (path) => path,
  openSocket: () => {
    throw new Error("these tests open no socket");
  },
  fetch: (input, init) => globalThis.fetch(input, init),
  servesUrls: true,
  content: null,
  machine: true,
  telemetry: true,
};
const fetchEndpoint = fetchEndpointOver(page);

/** Install a fetch that answers each call with the next step, in order. */
function stubFetch(steps: (() => Response)[]) {
  const fn = mock(() => {
    const step = steps.shift();
    if (!step) throw new Error("fetch called more times than stubbed");
    return Promise.resolve(step());
  });
  globalThis.fetch = fn as unknown as typeof fetch;
  return fn;
}

const status = (code: number) => () => new Response("down", { status: code });
const ok = () => () => Response.json({ ok: true });
const networkError = () => () => {
  throw new TypeError("Failed to fetch");
};

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("fetchEndpoint retry", () => {
  test("a 503 followed by a 200 succeeds", async () => {
    const fn = stubFetch([status(503), ok()]);
    const res = await fetchEndpoint(ping, {}, { body: { n: 1 }, retry: RETRY });
    expect(res).toEqual({ ok: true });
    expect(fn).toHaveBeenCalledTimes(2);
  });

  test("a network error on every attempt throws after the last one", async () => {
    const fn = stubFetch([networkError(), networkError(), networkError()]);
    const call = fetchEndpoint(ping, {}, { body: { n: 1 }, retry: RETRY });
    expect(call).rejects.toMatchObject({ message: "Failed to fetch" });
    expect(fn).toHaveBeenCalledTimes(RETRY.retries + 1);
  });

  test("a 503 on every attempt ends as an EndpointError for that status", async () => {
    stubFetch([status(503), status(503), status(503)]);
    const call = fetchEndpoint(
      ping,
      {},
      { body: { n: 1 }, retry: RETRY, report: false },
    );
    expect(call).rejects.toBeInstanceOf(EndpointError);
    expect(call).rejects.toMatchObject({ status: 503, body: "down" });
  });

  test("a 400 is not retried", async () => {
    const fn = stubFetch([status(400), ok()]);
    const call = fetchEndpoint(
      ping,
      {},
      { body: { n: 1 }, retry: RETRY, report: false },
    );
    expect(call).rejects.toMatchObject({ status: 400 });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test("without the retry option a 503 is a single attempt", async () => {
    const fn = stubFetch([status(503), ok()]);
    const call = fetchEndpoint(ping, {}, { body: { n: 1 }, report: false });
    expect(call).rejects.toMatchObject({ status: 503 });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test("resends the same request on each attempt", async () => {
    const fn = stubFetch([status(502), ok()]);
    await fetchEndpoint(ping, {}, { body: { n: 7 }, retry: RETRY });
    const calls = fn.mock.calls as unknown as [string, RequestInit][];
    expect(calls.map(([url, init]) => [url, init.method, init.body])).toEqual([
      ["/api/ping", "POST", '{"n":7}'],
      ["/api/ping", "POST", '{"n":7}'],
    ]);
  });
});

describe("fetchEndpoint unsupported refusal", () => {
  /** Record what reaches the endpoint error sink while `run` executes. */
  function sinkDuring(run: () => void) {
    const emitted: EndpointErrorInfo[] = [];
    endpointErrorSink.register((info) => emitted.push(info));
    try {
      run();
    } finally {
      endpointErrorSink.register(null);
    }
    return emitted;
  }

  // A host's refusal is a gap the coverage guard missed — never hidden.
  test("a host's unsupported refusal is a plain EndpointError, reported", async () => {
    stubFetch([() => unsupportedEndpointResponse("POST", "/api/ping")]);
    const emitted = sinkDuring(() => {
      const call = fetchEndpoint(ping, {}, { body: { n: 1 } });
      expect(call).rejects.toBeInstanceOf(EndpointError);
      expect(call).rejects.toMatchObject({
        status: 409,
        body: { reason: "unsupported", method: "POST", path: "/api/ping" },
      });
    });
    expect(emitted).toEqual([
      {
        route: "POST /api/ping",
        status: 409,
        body: { reason: "unsupported", method: "POST", path: "/api/ping" },
      },
    ]);
  });
});

describe("fetchEndpoint needsMachine", () => {
  const launch = defineEndpoint({
    route: "POST /api/launch",
    body: z.object({ n: z.number() }),
    response: z.object({ ok: z.boolean() }),
    needsMachine: { feature: "Launching an agent" },
  });

  test("under a transport with no computer it answers unavailable, without a request", async () => {
    const fn = mock(() => Promise.resolve(Response.json({ ok: true })));
    const inBrowser: Transport = { ...page, fetch: fn, machine: false };
    const fetchEndpoint = fetchEndpointOver(inBrowser);
    const res = await fetchEndpoint(launch, {}, { body: { n: 1 } });
    expect(res).toEqual({
      kind: "unavailable",
      message:
        "Launching an agent isn't available in this version of the app — it needs equin running on your computer.",
    });
    expect(fn).toHaveBeenCalledTimes(0);
  });

  test("under the page's own server it asks, and answers ok with the value", async () => {
    const fn = stubFetch([ok()]);
    const res = await fetchEndpoint(launch, {}, { body: { n: 1 } });
    expect(res).toEqual({ kind: "ok", value: { ok: true } });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test("a portable endpoint still answers its value, not a result", async () => {
    stubFetch([ok()]);
    const res = await fetchEndpoint(ping, {}, { body: { n: 1 } });
    // @ts-expect-error — a portable endpoint's answer has no `kind`
    expect(res.kind).toBeUndefined();
    expect(res).toEqual({ ok: true });
  });
});

describe("fetchEndpoint of a read", () => {
  const health = defineEndpoint({
    route: "GET /api/health",
    response: z.object({ ok: z.boolean() }),
  });

  test("a GET def a cast got past tsc throws the ReadMarker, without a request", async () => {
    const fn = stubFetch([ok()]);
    const call = fetchEndpoint(
      health as unknown as typeof ping,
      {},
      { body: { n: 1 } },
    );
    expect(call).rejects.toBeInstanceOf(Error);
    expect(call).rejects.toThrow(`GET /api/health: ${health.read}`);
    expect(call).rejects.toThrow("useLive");
    expect(fn).toHaveBeenCalledTimes(0);
  });

  test("defineEndpoint derives the marker from the route's method", () => {
    expect(ping.read).toBeUndefined();
    expect(health.read).toContain("GET is a read");
    for (const method of ["PUT", "PATCH", "DELETE"] as const) {
      expect(
        defineEndpoint({
          route: `${method} /api/x`,
        }).read,
      ).toBeUndefined();
    }
    for (const method of ["HEAD", "OPTIONS"] as const) {
      expect(defineEndpoint({ route: `${method} /api/x` }).read).toBeDefined();
    }
  });
});

describe("fetchEndpointOver", () => {
  test("is one fetcher per transport", () => {
    expect(fetchEndpointOver(page)).toBe(fetchEndpoint);
    expect(fetchEndpointOver({ ...page })).not.toBe(fetchEndpoint);
  });
});
