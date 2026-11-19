import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { defineEndpoint } from "./define-endpoint";
import {
  EndpointError,
  EndpointNetworkError,
  EndpointResponseUnreadableError,
} from "./endpoint-error";
import { readEndpointResponse, sendEndpointRequest } from "./request";
import { FetchRequestError } from "@plugins/primitives/plugins/networking/plugins/request-guard/core";
import { crashFieldsOf } from "@plugins/packages/plugins/error-subject/core";

const collect = defineEndpoint({
  route: "POST /api/x/collect",
  body: z.object({ n: z.number() }),
  response: z.object({ ok: z.boolean() }),
});

describe("sendEndpointRequest", () => {
  test("a request with no answer names its route, and is still a TypeError", async () => {
    const cause = new TypeError(
      "NetworkError when attempting to fetch resource.",
    );
    let caught: unknown;
    try {
      await sendEndpointRequest(
        () => Promise.reject(cause),
        collect,
        {},
        { body: { n: 1 } },
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(EndpointNetworkError);
    expect(caught).toBeInstanceOf(TypeError);
    const err = caught as EndpointNetworkError;
    expect(err.name).toBe("EndpointNetworkError");
    expect(err.route).toBe("POST /api/x/collect");
    expect(err.message).toBe(
      "POST /api/x/collect: NetworkError when attempting to fetch resource.",
    );
    expect(err.cause).toBe(cause);
  });

  test("a page fetch the request guard named: the route said once, the caller's frames kept", async () => {
    const words = "Failed to fetch";
    const named = new FetchRequestError(
      "POST",
      "/api/x/collect",
      words,
      new TypeError(words),
    );
    named.stack = `FetchRequestError: ${named.message}\n    at caller (app.js:1:1)`;
    let caught: unknown;
    try {
      await sendEndpointRequest(
        () => Promise.reject(named),
        collect,
        {},
        { body: { n: 1 } },
      );
    } catch (err) {
      caught = err;
    }
    const err = caught as EndpointNetworkError;
    expect(err).toBeInstanceOf(EndpointNetworkError);
    expect(err.message).toBe("POST /api/x/collect: Failed to fetch");
    expect(err.cause).toBe(named);
    expect(err.stack).toBe(
      "EndpointNetworkError: POST /api/x/collect: Failed to fetch\n    at caller (app.js:1:1)",
    );
  });

  test("an abort passes through as the sender threw it", () => {
    const abort = new DOMException("The operation was aborted.", "AbortError");
    expect(
      sendEndpointRequest(
        () => Promise.reject(abort),
        collect,
        {},
        { body: { n: 1 } },
      ),
    ).rejects.toBe(abort);
  });

  test("an answer is returned as is, whatever its status", async () => {
    const res = new Response("down", { status: 502 });
    expect(
      await sendEndpointRequest(
        () => Promise.resolve(res),
        collect,
        {},
        { body: { n: 1 } },
      ),
    ).toBe(res);
  });
});

describe("readEndpointResponse — a refusal names its request", () => {
  async function refusal(res: Response): Promise<EndpointError> {
    try {
      await readEndpointResponse(collect, res);
    } catch (err) {
      if (err instanceof EndpointError) return err;
      throw err;
    }
    throw new Error("expected a refusal");
  }

  test("the principal gate's 403: status, route and the body's message", async () => {
    const err = await refusal(
      Response.json(
        {
          reason: "cross-site-refused",
          route: "POST /api/x/collect",
          message: "Refused: a cross-site request.",
        },
        { status: 403 },
      ),
    );
    expect(err.status).toBe(403);
    expect(err.message).toBe(
      "HTTP 403 from POST /api/x/collect: Refused: a cross-site request.",
    );
  });

  test("a body with only a reason gives the reason", async () => {
    const err = await refusal(
      Response.json({ reason: "unauthorized" }, { status: 403 }),
    );
    expect(err.message).toBe("HTTP 403 from POST /api/x/collect: unauthorized");
  });

  test("a plain-text body gives its first line; an empty one only the route", async () => {
    expect(
      (await refusal(new Response("Not found\nmore", { status: 404 }))).message,
    ).toBe("HTTP 404 from POST /api/x/collect: Not found");
    expect((await refusal(new Response("", { status: 502 }))).message).toBe(
      "HTTP 502 from POST /api/x/collect",
    );
  });

  test("a caller's own describe wins", async () => {
    try {
      await readEndpointResponse(
        collect,
        new Response("x", { status: 500 }),
        (status) => `custom ${status}`,
      );
    } catch (err) {
      expect((err as Error).message).toBe("custom 500");
      return;
    }
    throw new Error("expected a refusal");
  });
});

describe("EndpointError's crash identity", () => {
  const refused = async (
    endpoint: Parameters<typeof readEndpointResponse>[0],
    status: number,
  ): Promise<EndpointError> => {
    try {
      await readEndpointResponse(endpoint, new Response("no", { status }));
    } catch (err) {
      if (err instanceof EndpointError) return err;
      throw err;
    }
    throw new Error("expected a refusal");
  };
  const other = defineEndpoint({ route: "POST /api/notifications" });

  test("is its route and status, so refused calls of different routes are different reports", async () => {
    // report-1795027021-vfag0v: a 403 toast write and an analytics 400 shared
    // one report — the same throw site, so the same stack.
    const a = await refused(collect, 400);
    const b = await refused(other, 403);
    expect(crashFieldsOf(a).scope).toBe("POST /api/x/collect 400");
    expect(crashFieldsOf(b).scope).toBe("POST /api/notifications 403");
    expect(crashFieldsOf(await refused(collect, 500)).scope).toBe(
      "POST /api/x/collect 500",
    );
  });
});

describe("readEndpointResponse — a 2xx it cannot decode names its request", () => {
  async function failure(res: Response): Promise<unknown> {
    try {
      await readEndpointResponse(collect, res);
    } catch (err) {
      return err;
    }
    throw new Error("expected a failure");
  }

  test("an empty 200 with no declared length: unreadable, route and status named", async () => {
    const err = await failure(new Response(null, { status: 200 }));
    expect(err).toBeInstanceOf(EndpointResponseUnreadableError);
    expect(err).toBeInstanceOf(EndpointError);
    const e = err as EndpointResponseUnreadableError;
    expect(e.route).toBe("POST /api/x/collect");
    expect(e.status).toBe(200);
    expect(e.receivedBytes).toBe(0);
    expect(e.cause).toBeInstanceOf(SyntaxError);
    expect(e.message).toStartWith(
      "HTTP 200 from POST /api/x/collect: unreadable response body (0 bytes, no length declared: ",
    );
  });

  test("a whole body that is not JSON: unreadable, with its declared length", async () => {
    const err = await failure(
      new Response("<html>", {
        status: 200,
        headers: { "content-length": "6" },
      }),
    );
    expect(err).toBeInstanceOf(EndpointResponseUnreadableError);
    expect((err as Error).message).toContain("6 of 6 declared bytes");
  });

  test("fewer bytes than declared: the answer was cut short — a network error", async () => {
    const err = await failure(
      new Response('{"ok":', {
        status: 200,
        headers: { "content-length": "11" },
      }),
    );
    expect(err).toBeInstanceOf(EndpointNetworkError);
    expect(err).toBeInstanceOf(TypeError);
    expect((err as Error).message).toBe(
      "POST /api/x/collect: the answer was cut short: 6 of 11 bytes arrived (HTTP 200)",
    );
  });

  test("a compressed reply's length is not compared: unreadable", async () => {
    const err = await failure(
      new Response("", {
        status: 200,
        headers: { "content-length": "40", "content-encoding": "br" },
      }),
    );
    expect(err).toBeInstanceOf(EndpointResponseUnreadableError);
  });

  test("a body stream that fails mid-read: a network error naming the route", async () => {
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new TypeError("network error"));
      },
    });
    const err = await failure(new Response(body, { status: 200 }));
    expect(err).toBeInstanceOf(EndpointNetworkError);
    expect((err as Error).message).toBe("POST /api/x/collect: network error");
  });

  test("a schema mismatch passes through untouched", async () => {
    const err = await failure(Response.json({ ok: "yes" }));
    expect(err).not.toBeInstanceOf(EndpointError);
    expect(err).not.toBeInstanceOf(TypeError);
  });
});
