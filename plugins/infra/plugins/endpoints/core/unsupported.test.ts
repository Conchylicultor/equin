import { describe, expect, test } from "bun:test";
import {
  isUnsupportedEndpointRefusal,
  isUnsupportedEndpointResponse,
  unmatchedApiResponse,
  unsupportedEndpointResponse,
} from "./unsupported";

describe("unmatchedApiResponse", () => {
  test("an /api path is the unsupported refusal", async () => {
    const res = unmatchedApiResponse(
      new Request("http://host.invalid/api/x", { method: "POST" }),
      "/api/x",
    );
    expect(isUnsupportedEndpointRefusal(res.status, await res.json())).toBe(
      true,
    );
  });

  test("any other path is a 404 naming it", async () => {
    const res = unmatchedApiResponse(
      new Request("http://host.invalid/apix"),
      "/apix",
    );
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("Not found: /apix");
  });
});

describe("isUnsupportedEndpointResponse", () => {
  test("the refusal is one, and its body is still readable after", async () => {
    const res = unsupportedEndpointResponse("POST", "/api/x");
    expect(await isUnsupportedEndpointResponse(res)).toBe(true);
    expect(await res.json()).toEqual({
      reason: "unsupported",
      method: "POST",
      path: "/api/x",
    });
  });

  test("another status is not, whatever its body", async () => {
    const body = { reason: "unsupported", method: "GET", path: "/api/x" };
    expect(
      await isUnsupportedEndpointResponse(Response.json(body, { status: 200 })),
    ).toBe(false);
    expect(
      await isUnsupportedEndpointResponse(Response.json(body, { status: 404 })),
    ).toBe(false);
  });

  test("a 409 that is not the refusal is not one", async () => {
    expect(
      await isUnsupportedEndpointResponse(
        new Response("conflict: already exists", { status: 409 }),
      ),
    ).toBe(false);
    expect(
      await isUnsupportedEndpointResponse(
        Response.json({ reason: "contract-mismatch" }, { status: 409 }),
      ),
    ).toBe(false);
    expect(
      await isUnsupportedEndpointResponse(new Response(null, { status: 409 })),
    ).toBe(false);
  });
});
