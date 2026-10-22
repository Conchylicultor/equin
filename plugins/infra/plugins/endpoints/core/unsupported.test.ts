import { describe, expect, test } from "bun:test";
import { unmatchedApiResponse } from "./unsupported";

describe("unmatchedApiResponse", () => {
  test("an /api path is the unsupported refusal", async () => {
    const res = unmatchedApiResponse(
      new Request("http://host.invalid/api/x", { method: "POST" }),
      "/api/x",
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      reason: "unsupported",
      method: "POST",
      path: "/api/x",
    });
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
