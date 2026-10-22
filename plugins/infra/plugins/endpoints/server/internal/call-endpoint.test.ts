import { afterEach, describe, expect, mock, test } from "bun:test";
import { z } from "zod";
import { defineEndpoint } from "../../core/define-endpoint";
import {
  EndpointAgentWriteRefusedError,
  EndpointError,
} from "../../core/endpoint-error";
import { callEndpoint } from "./call-endpoint";

const ORIGIN = "http://localhost:9000";

const getItem = defineEndpoint({
  route: "GET /api/items/:id",
  query: z.object({ full: z.boolean().optional() }),
  response: z.object({ id: z.string(), n: z.number() }),
});

const setItem = defineEndpoint({
  route: "POST /api/items/set",
  body: z.object({ id: z.string() }),
});

const realFetch = globalThis.fetch;
let calls: { url: string; init: RequestInit }[] = [];

function answer(res: () => Response): void {
  calls = [];
  globalThis.fetch = mock((url: string, init: RequestInit) => {
    calls.push({ url, init });
    return Promise.resolve(res());
  }) as unknown as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("callEndpoint", () => {
  test("builds the URL from origin, params and query, and decodes the answer", async () => {
    answer(() => Response.json({ id: "a", n: 1 }));
    const got = await callEndpoint(
      getItem,
      { id: "a b" },
      { origin: ORIGIN, query: { full: true } },
    );
    expect(got).toEqual({ id: "a", n: 1 });
    expect(calls[0]!.url).toBe(`${ORIGIN}/api/items/a%20b?full=true`);
    expect(calls[0]!.init.method).toBe("GET");
  });

  test("a reply the response schema rejects throws", async () => {
    answer(() => Response.json({ ok: true }));
    let caught: unknown;
    try {
      await callEndpoint(getItem, { id: "a" }, { origin: ORIGIN, query: {} });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(z.ZodError);
  });

  test("an endpoint declaring no response answers void on 204, encoding the body", async () => {
    answer(() => new Response(null, { status: 204 }));
    const got: void = await callEndpoint(
      setItem,
      {},
      { origin: ORIGIN, body: { id: "x" } },
    );
    expect(got).toBeUndefined();
    expect(calls[0]!.init.method).toBe("POST");
    expect(calls[0]!.init.body).toBe(JSON.stringify({ id: "x" }));
    expect(
      (calls[0]!.init.headers as Record<string, string>)["Content-Type"],
    ).toBe("application/json");
  });

  test("a non-2xx throws EndpointError with the body, text or JSON", async () => {
    answer(() => new Response("nope", { status: 400 }));
    let caught: unknown;
    try {
      await callEndpoint(setItem, {}, { origin: ORIGIN, body: { id: "x" } });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(EndpointError);
    expect((caught as EndpointError).status).toBe(400);
    expect((caught as EndpointError).body).toBe("nope");
    expect((caught as EndpointError).message).toBe(
      `POST ${ORIGIN}/api/items/set: HTTP 400 nope`,
    );
  });

  test("main's agent-write refusal is refined", async () => {
    answer(() =>
      Response.json(
        {
          reason: "agent-write-refused",
          route: setItem.route,
          message: "main is read-only for agents",
        },
        { status: 403 },
      ),
    );
    let caught: unknown;
    try {
      await callEndpoint(setItem, {}, { origin: ORIGIN, body: { id: "x" } });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(EndpointAgentWriteRefusedError);
  });

  test("the contract types the call", () => {
    // Type-level only: never sent.
    const typed = () => {
      const voidAnswer = callEndpoint(
        setItem,
        {},
        { origin: ORIGIN, body: { id: "x" } },
      );
      // @ts-expect-error — a void endpoint has no answer to read
      void voidAnswer.then((r) => r.ok);
      // @ts-expect-error — the body is the contract's
      void callEndpoint(setItem, {}, { origin: ORIGIN, body: { nope: 1 } });
      // @ts-expect-error — the route's params are required
      void callEndpoint(getItem, {}, { origin: ORIGIN, query: {} });
    };
    expect(typeof typed).toBe("function");
  });
});
