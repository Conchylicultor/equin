import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { defineEndpoint } from "./define-endpoint";
import { EndpointError, EndpointNetworkError } from "./endpoint-error";
import { readEndpointResponse, sendEndpointRequest } from "./request";

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
