import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { defineEndpoint } from "./define-endpoint";
import { implement, rawEndpointHandler } from "./implement";

const req = () => new Request("http://localhost/api/thing");

describe("implement", () => {
  test("a null result of a nullable response is JSON null, not a 204", async () => {
    const ep = defineEndpoint({
      route: "GET /api/thing",
      response: z.object({ a: z.string() }).nullable(),
    });
    const res = await implement(ep, () => null)(req(), {});
    expect(res.status).toBe(200);
    expect(await ep.responseCodec!.decodeResponse(res)).toBeNull();
  });

  test("an undefined result is a 204", async () => {
    const ep = defineEndpoint({
      route: "POST /api/thing",
      unpredicted: { reason: "response", why: "test fixture" },
    });
    const res = await implement(ep, () => undefined)(req(), {});
    expect(res.status).toBe(204);
  });
});

describe("access", () => {
  test("a declaration without access is owner, and the handler carries it", () => {
    const ep = defineEndpoint({
      route: "POST /api/thing",
      unpredicted: { reason: "response", why: "test fixture" },
    });
    expect(ep.access).toBe("owner");
    expect(implement(ep, () => undefined).access).toBe("owner");
  });

  test("a public declaration rides on implement and raw handlers", () => {
    const ep = defineEndpoint({
      route: "GET /api/cb",
      access: { public: "nonce-authenticated" },
    });
    expect(ep.access).toEqual({ public: "nonce-authenticated" });
    expect(implement(ep, () => undefined).access).toEqual({
      public: "nonce-authenticated",
    });
    expect(rawEndpointHandler(ep, () => new Response("x")).access).toEqual({
      public: "nonce-authenticated",
    });
  });

  test("a raw handler of a bare route declaration is owner", () => {
    const raw = () => new Response("x");
    const handler = rawEndpointHandler(
      { route: "POST /api/raw", method: "POST" },
      raw,
    );
    expect(handler.access).toBe("owner");
    // A fresh function: the raw one is never stamped, so it can serve another
    // route under another access.
    expect(handler).not.toBe(raw);
    expect("access" in raw).toBe(false);
  });

  test("an empty public reason throws at declaration", () => {
    expect(() =>
      defineEndpoint({ route: "GET /api/cb", access: { public: " " } }),
    ).toThrow(/needs a reason/);
  });

  test('"owner" has no spelling in a declaration', () => {
    const declare = () =>
      defineEndpoint({
        route: "GET /api/x",
        // @ts-expect-error — owner is the absence of access, never written
        access: "owner",
      });
    expect(declare).toThrow(/or absent \(owner\)/);
  });
});
