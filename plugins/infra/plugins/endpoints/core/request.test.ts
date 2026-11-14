import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { defineEndpoint } from "./define-endpoint";
import { EndpointNetworkError } from "./endpoint-error";
import { sendEndpointRequest } from "./request";

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
