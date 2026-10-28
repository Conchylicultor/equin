import { describe, expect, test } from "bun:test";
import {
  PRINCIPAL_HEADER,
  crossSiteRefusedResponse,
  isBrowserRequest,
  isCrossSiteRefusal,
  principalOf,
} from "./principal";

const req = (headers: Record<string, string> = {}) =>
  new Request("http://localhost/api/x", { headers });

describe("principalOf", () => {
  test("owner exactly is the owner", () => {
    expect(principalOf(req({ [PRINCIPAL_HEADER]: "owner" }))).toEqual({
      kind: "owner",
    });
  });

  test("the header name is case-insensitive", () => {
    expect(principalOf(req({ "X-Equin-Principal": "owner" })).kind).toBe(
      "owner",
    );
  });

  test("fails closed: missing, anonymous, or anything else", () => {
    expect(principalOf(req()).kind).toBe("anonymous");
    expect(principalOf(req({ [PRINCIPAL_HEADER]: "anonymous" })).kind).toBe(
      "anonymous",
    );
    expect(principalOf(req({ [PRINCIPAL_HEADER]: "Owner" })).kind).toBe(
      "anonymous",
    );
    // Two stamps (a client's that slipped past, and the gateway's) combine
    // into one value: not exactly "owner".
    const twice = new Headers();
    twice.append(PRINCIPAL_HEADER, "owner");
    twice.append(PRINCIPAL_HEADER, "owner");
    expect(
      principalOf(new Request("http://localhost/", { headers: twice })).kind,
    ).toBe("anonymous");
    expect(principalOf(req({ [PRINCIPAL_HEADER]: "" })).kind).toBe("anonymous");
  });
});

describe("crossSiteRefusedResponse", () => {
  test("is a 403 the client recognises", async () => {
    const res = crossSiteRefusedResponse("POST /api/x");
    expect(res.status).toBe(403);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.reason).toBe("cross-site-refused");
    expect(body.route).toBe("POST /api/x");
    expect(isCrossSiteRefusal(res.status, body)).toBe(true);
  });

  test("another 403 is not the refusal", () => {
    expect(isCrossSiteRefusal(403, { reason: "agent-write-refused" })).toBe(
      false,
    );
    expect(
      isCrossSiteRefusal(500, {
        reason: "cross-site-refused",
        route: "x",
        message: "y",
      }),
    ).toBe(false);
  });
});

describe("isBrowserRequest", () => {
  test("a local tool sends no browser headers", () => {
    expect(isBrowserRequest(req())).toBe(false);
    expect(isBrowserRequest(req({ [PRINCIPAL_HEADER]: "owner" }))).toBe(false);
  });

  test("Origin or any Sec-Fetch-* header is a browser", () => {
    expect(isBrowserRequest(req({ Origin: "http://localhost:9000" }))).toBe(
      true,
    );
    expect(isBrowserRequest(req({ "Sec-Fetch-Site": "same-origin" }))).toBe(
      true,
    );
    expect(isBrowserRequest(req({ "Sec-Fetch-Mode": "cors" }))).toBe(true);
  });
});
