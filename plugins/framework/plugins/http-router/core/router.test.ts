import { describe, expect, test } from "bun:test";
import { createRequestHandler, type RouteHandler } from "./router";

const ok =
  (body: string): RouteHandler =>
  (_req, params) =>
    Response.json({ body, params });

function req(method: string, path: string): Request {
  return new Request(`http://localhost${path}`, { method });
}

function noError(): never {
  throw new Error("onError must not be called");
}

describe("createRequestHandler", () => {
  test("matches a literal route", async () => {
    const handle = createRequestHandler({
      routes: [["GET /api/a", ok("a")]],
      onError: noError,
    });
    const res = await handle(req("GET", "/api/a"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ body: "a", params: {} });
  });

  test("matches a :param route and decodes its segments", async () => {
    const handle = createRequestHandler({
      routes: [["GET /api/items/:id/:sub", ok("item")]],
      onError: noError,
    });
    const res = await handle(req("GET", "/api/items/a%2Fb%20c/x"));
    expect(await res.json()).toEqual({
      body: "item",
      params: { id: "a/b c", sub: "x" },
    });
  });

  test("filters by method, literal and param alike", async () => {
    const handle = createRequestHandler({
      routes: [
        ["GET /api/a", ok("get-a")],
        ["POST /api/a", ok("post-a")],
        ["GET /api/items/:id", ok("get-item")],
        ["DELETE /api/items/:id", ok("delete-item")],
      ],
      onError: noError,
    });
    expect((await (await handle(req("POST", "/api/a"))).json()).body).toBe(
      "post-a",
    );
    expect(
      (await (await handle(req("DELETE", "/api/items/1"))).json()).body,
    ).toBe("delete-item");
    expect((await handle(req("PUT", "/api/items/1"))).status).toBe(404);
  });

  test("param routes match in registration order", async () => {
    const handle = createRequestHandler({
      routes: [
        ["GET /api/:x/b", ok("first")],
        ["GET /api/a/:y", ok("second")],
      ],
      onError: noError,
    });
    expect((await (await handle(req("GET", "/api/a/b"))).json()).body).toBe(
      "first",
    );
  });

  test("defaults cache-control to no-store", async () => {
    const handle = createRequestHandler({
      routes: [["GET /api/a", ok("a")]],
      onError: noError,
    });
    const res = await handle(req("GET", "/api/a"));
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  test("keeps a handler-set cache-control", async () => {
    const handle = createRequestHandler({
      routes: [
        [
          "GET /api/img/:id",
          () =>
            new Response("x", {
              headers: { "cache-control": "public, max-age=60" },
            }),
        ],
      ],
      onError: noError,
    });
    const res = await handle(req("GET", "/api/img/1"));
    expect(res.headers.get("cache-control")).toBe("public, max-age=60");
  });

  test("a throw calls onError and answers a JSON 500", async () => {
    const errors: Array<{ message: string; method: string; pathname: string }> =
      [];
    const handle = createRequestHandler({
      routes: [
        [
          "GET /api/boom/:id",
          () => {
            throw new Error("kaboom");
          },
        ],
        [
          "POST /api/reject",
          () => Promise.reject(new TypeError("async kaboom")),
        ],
      ],
      onError: (err, r, pathname) =>
        errors.push({ message: err.message, method: r.method, pathname }),
    });
    const res = await handle(req("GET", "/api/boom/1"));
    expect(res.status).toBe(500);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ error: "Internal server error" });

    const res2 = await handle(req("POST", "/api/reject"));
    expect(res2.status).toBe(500);
    expect(errors).toEqual([
      { message: "kaboom", method: "GET", pathname: "/api/boom/1" },
      { message: "async kaboom", method: "POST", pathname: "/api/reject" },
    ]);
  });

  test("a duplicate route key throws at construction", () => {
    expect(() =>
      createRequestHandler({
        routes: [
          ["GET /api/items/:id", ok("a")],
          ["GET /api/items/:id", ok("b")],
        ],
        onError: noError,
      }),
    ).toThrow("duplicate route: GET /api/items/:id");
  });

  test("unmatched defaults to 404 Not found", async () => {
    const handle = createRequestHandler({ routes: [], onError: noError });
    const res = await handle(req("GET", "/nope"));
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("Not found");
  });

  test("onUnmatched replaces the 404", async () => {
    const handle = createRequestHandler({
      routes: [["GET /api/a", ok("a")]],
      onError: noError,
      onUnmatched: (r, pathname) =>
        Response.json({ missing: `${r.method} ${pathname}` }, { status: 409 }),
    });
    const res = await handle(req("GET", "/api/b"));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ missing: "GET /api/b" });
  });
});
